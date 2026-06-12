import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import https from 'https';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import containerRoutes from './routes/containers.js';
import infoRoutes from './routes/info.js';
import eventRoutes from './routes/events.js';
import nodeRoutes from './routes/nodes.js';
import secretRoutes from './routes/secrets.js';
import taskRoutes from './routes/tasks.js';
import settingsRoutes from './routes/settings.js';
import groupRoutes from './routes/groups.js';
import {reconcileContainers, startReconciler, stopReconciler} from './services/reconciler.js';
import {bootstrapEtcd, addEtcdMember, migrateToCluster, clearClusterConfig} from './services/etcd-cluster.js';
import {closeEtcd, etcd, registerLocalNode, waitForEtcd, saveNode, updateEtcdHosts, reconnectEtcd} from './services/db.js';
import {startScheduler, stopScheduler} from './services/scheduler.js';
import {startOrchestrator, stopOrchestrator} from './services/orchestrator.js';
import {bootstrapNginx, getNodeUrl} from './services/nginx.js';
import {startLogger, logEvent} from './services/logger.js';
import docker from './services/docker.js';
import {runMigrations} from './services/migrations.js';
import migrations from './migrations/index.js';
import {v4 as uuidv4} from 'uuid';
import {
  changeMasterPassword,
  initializeSystem,
  isNodeSealed,
  isSystemInitialized,
  rotateDEK,
  unsealNode,
  verifyClusterToken,
  verifyMasterPassword,
  getOrCreateJwtSecret,
  getJwtSecret,
} from './services/secrets.js';
import { isTokenBlacklisted, blacklistToken, refreshToken, signToken, revokeAllSessions, checkSessionGeneration } from './services/session.js';
import { nodeId } from './config.js';

const app = express();
const port = process.env.PORT || 3000;

// Trust the first reverse proxy (nginx) so req.ip returns the real client IP
// and express-rate-limit correctly identifies individual clients.
app.set('trust proxy', 1);

let JWT_SECRET = null;
let isShuttingDown = false;
const nodeName = process.env.NODE_NAME || 'node-1';
const nodeIp = process.env.NODE_IP || '127.0.0.1';
const clientIp = process.env.NODE_CLIENT_IP || nodeIp;
let clusterBooted = false;

// Helper: HTTPS fetch that skips SSL verification for inter-node cluster traffic
// (self-signed certs on the backhaul network)
function insecureFetch(url, opts = {}) {
  const method = opts.method || 'GET';
  console.log(`[Cluster] → ${method} ${url}`);
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(u, {
      method,
      headers: opts.headers || {},
      rejectUnauthorized: false,
      timeout: 60000, // 60s timeout for inter-node API calls
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        console.log(`[Cluster] ← ${res.statusCode} from ${method} ${url} (${body.length} bytes)`);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: async () => JSON.parse(body),
          text: async () => body,
        });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      console.error(`[Cluster] ← TIMEOUT from ${method} ${url}`);
      reject(new Error(`Request timed out: ${method} ${url}`));
    });
    req.on('error', (err) => {
      console.error(`[Cluster] ← ERROR from ${method} ${url}: ${err.message}`);
      reject(err);
    });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "ws:"],
      fontSrc: ["'self'"],
    },
  },
}));
app.use(cookieParser());
app.use(express.json());

// CORS: reject misconfigured origins that would allow any website with credentials.
// Server-to-server calls (join, event proxying) use insecureFetch which bypasses CORS.
const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
if (corsOrigin === 'true' || corsOrigin === '*') {
  console.error('[Security] CORS_ORIGIN cannot be "true" or "*" with credentials enabled. Falling back to http://localhost:3000');
}
app.use(cors({
  origin: (corsOrigin === 'true' || corsOrigin === '*') ? 'http://localhost:3000' : corsOrigin,
  credentials: true,
}));

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, try again later' },
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, try again later' },
});

app.use('/api/system', authLimiter);

app.use('/api', generalLimiter);

const mutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many mutation requests, try again later', code: 'MUTATION_LIMITED' },
});

const mutationRateLimit = (req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    return mutationLimiter(req, res, next);
  }
  next();
};

// Brute force protection — tracks failed auth attempts per IP in etcd.
// After 5 failures the IP is locked out for 2^failures minutes (max 24h).
const BRUTE_KEY_PREFIX = 'system/brute/';
const BRUTE_MAX_FAILURES = 5;
const BRUTE_LOCKOUT_CAP_MIN = 1440; // 24h

async function checkBruteForce(ip) {
  try {
    const raw = await etcd.get(`${BRUTE_KEY_PREFIX}${ip}`).string();
    if (!raw) return null;
    const { count, lastAttempt } = JSON.parse(raw);
    const lockoutMin = Math.min(Math.pow(2, count), BRUTE_LOCKOUT_CAP_MIN);
    const elapsed = (Date.now() - lastAttempt) / 60000;
    if (elapsed < lockoutMin) {
      return { locked: true, remainingMin: Math.ceil(lockoutMin - elapsed), count };
    }
    return { locked: false, count };
  } catch { return null; }
}

async function recordFailedAttempt(ip) {
  try {
    const raw = await etcd.get(`${BRUTE_KEY_PREFIX}${ip}`).string();
    const entry = raw ? JSON.parse(raw) : { count: 0, lastAttempt: 0 };
    entry.count += 1;
    entry.lastAttempt = Date.now();
    const ttl = Math.min(Math.pow(2, entry.count), BRUTE_LOCKOUT_CAP_MIN) * 60;
    // Use lease.put directly (not plain put first) so the entry auto-clears.
    // If lease creation fails, the old entry (if any) stays until its own TTL expires.
    const lease = etcd.lease(ttl);
    await lease.put(`${BRUTE_KEY_PREFIX}${ip}`).value(JSON.stringify(entry));
  } catch (e) { console.error('[BruteForce] Failed to record attempt:', e.message); }
}

async function clearBruteForce(ip) {
  try { await etcd.delete().key(`${BRUTE_KEY_PREFIX}${ip}`); } catch {}
}

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    nodeId,
    nodeName,
    sealed: isNodeSealed(),
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

const bootCluster = async (nodeId) => {
  if (clusterBooted) {
    console.log('[Cluster] Already booted.');
    return;
  }
  if (isNodeSealed()) {
    console.log('[Cluster] Cannot boot: Node is sealed.');
    return;
  }
  console.log('[Cluster] Booting services...');
  try {
    startLogger();
    // Fire-and-forget: don't block setup on full reconciliation.
    // Services start in the background so the join/unseal response returns immediately.
    reconcileContainers(nodeId).catch(e => console.error('[Cluster] Initial reconcile failed:', e.message));
    startScheduler();
    startOrchestrator(nodeId);
    startReconciler(nodeId);
    clusterBooted = true;
    console.log('[Cluster] Services started successfully.');
    // Run migrations in background — non-blocking
    runMigrations(migrations).catch(e => console.error('[Cluster] Migrations failed:', e.message));
  } catch (e) {
    console.error(`[Cluster] Boot failed: ${e.message}`);
  }
};

const requireAuth = async (req, res, next) => {
  if (!JWT_SECRET) {
    return res.status(503).json({ error: 'JWT secret not yet initialized', code: 'SERVICE_NOT_READY' });
  }
  const token = req.cookies.token;
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const clusterToken = authHeader.split(' ')[1];
    try {
      req.clusterNode = verifyClusterToken(clusterToken);
      return next();
    } catch (err) {
      console.warn('[Auth] Invalid cluster token:', err.message);
    }
  }

  if (!token) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    if (req.user.jti && await isTokenBlacklisted(req.user.jti)) {
      res.clearCookie('token');
      return res.status(401).json({ error: 'Session has been revoked', code: 'SESSION_REVOKED' });
    }
    if (!await checkSessionGeneration(req.user)) {
      res.clearCookie('token');
      return res.status(401).json({ error: 'Session generation expired (password changed or node re-unsealed)', code: 'SESSION_GEN_EXPIRED' });
    }
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired session', code: 'INVALID_TOKEN' });
  }
};

const requireUnsealed = (req, res, next) => {
  if (isNodeSealed()) {
    return res.status(423).json({
      error: 'Node is sealed',
      code: 'NODE_SEALED',
      nodeId,
      nodeName,
      sealed: true,
    });
  }
  next();
};

app.use('/api/containers', requireAuth, requireUnsealed, mutationRateLimit, containerRoutes);
app.use('/api/info', requireAuth, infoRoutes);
app.use('/api/events', requireAuth, eventRoutes);
app.use('/api/nodes', requireAuth, nodeRoutes);
app.use('/api/secrets', requireAuth, requireUnsealed, secretRoutes);
app.use('/api/tasks', requireAuth, requireUnsealed, taskRoutes);
app.use('/api/settings', requireAuth, requireUnsealed, settingsRoutes);
app.use('/api/groups', requireAuth, requireUnsealed, mutationRateLimit, groupRoutes);

app.get('/api/system/status', async (req, res) => {
  let authenticated = false;
  if (req.cookies.token && JWT_SECRET) {
    try {
      jwt.verify(req.cookies.token, JWT_SECRET);
      authenticated = true;
    } catch (err) {}
  }

  let initialized;
  let sealed;
  initialized = await isSystemInitialized();
  sealed = isNodeSealed();

  res.json({
    initialized,
    sealed,
    authenticated,
    nodeId: (!initialized && !authenticated) ? undefined : nodeId,
    nodeName: (!initialized && !authenticated) ? undefined : nodeName,
  });
});

import multer from 'multer';
import { SYSTEM_NAMESPACE } from './services/ephemeral-tasks.js';

async function performPostRestoreMigration() {
  console.log('[Restore] Running pending migrations...');
  await runMigrations(migrations);
}

async function restoreSystem(snapshotPath, password) {
  console.log('Restoring from snapshot:', snapshotPath);
  const fs = await import('fs');
  const snapshotData = fs.readFileSync(snapshotPath);

  // Validate snapshot: etcd v3 snapshots are binary protobuf, not plaintext.
  // Check first 8 bytes are not all ASCII printable (would indicate HTML/JSON/text).
  if (snapshotData.length < 64) {
    throw new Error('Snapshot file is too small to be a valid etcd backup');
  }
  const head = snapshotData.subarray(0, 8);
  let printableCount = 0;
  for (const b of head) {
    if (b >= 0x20 && b <= 0x7e) printableCount++;
  }
  if (printableCount >= 6) {
    throw new Error('Snapshot file does not appear to be a valid etcd backup (plaintext content detected)');
  }

  const destPath = `/mnt/backup/${SYSTEM_NAMESPACE}/etcd-snapshot-restore.db`;
  fs.writeFileSync(destPath, snapshotData);
  console.log('Snapshot copied to', destPath);
  await initializeSystem(password);
}

const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 1024 * 1024 * 1024 } });

app.post('/api/system/setup', upload.single('snapshotFile'), async (req, res) => {
  try {
    const clientIp = req.ip;
    const bf = await checkBruteForce(clientIp);
    if (bf?.locked) {
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${bf.remainingMin} minutes.`, code: 'BRUTE_LOCKED' });
    }

    const { mode, password, primaryIp, joinToken } = req.body;

    if (mode === 'create' || !mode) {
      await initializeSystem(password);
      JWT_SECRET = getJwtSecret();
      if (!JWT_SECRET) {
        // Fallback for backward compat — shouldn't happen with new init
        JWT_SECRET = await getOrCreateJwtSecret();
      }
      await registerLocalNode(nodeId, nodeName, nodeIp, clientIp);
      await bootCluster(nodeId);
      logEvent('security', 'info', 'System initialized (create)', { nodeId, nodeName });
    } else if (mode === 'join') {
      const startTime = Date.now();
      console.log(`[Cluster] Joining cluster via primary ${primaryIp} as ${nodeName} (ip=${nodeIp}, clientIp=${clientIp})`);
      const joinUrl = `${getNodeUrl(primaryIp)}/api/system/join`;
      console.log(`[Cluster] Sending join request to ${joinUrl}`);

      const joinRes = await insecureFetch(joinUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${joinToken}`,
        },
        body: JSON.stringify({ name: nodeName, ip: nodeIp, clientIp }),
      });
      const elapsed = Date.now() - startTime;
      if (!joinRes.ok) {
        const resBody = await joinRes.text();
        console.error(`[Cluster] Join request failed after ${elapsed}ms (status ${joinRes.status}): ${resBody}`);
        throw new Error('Failed to join cluster: ' + resBody);
      }

      console.log(`[Cluster] Join response received in ${elapsed}ms`);
      const joinData = await joinRes.json();
      console.log(`[Cluster] Join response: memberName=${joinData.clusterConfig?.memberName}, initialCluster=${joinData.clusterConfig?.initialCluster}, clientUrls=[${(joinData.clusterConfig?.memberClientUrls || []).join(', ')}]`);

      if (!joinData.clusterConfig) {
        // Legacy leader — no cluster config returned, fall through
        return res.json({ success: true, joined: true, data: joinData });
      }

      // Migrate local etcd from standalone to clustered
      console.log('[Cluster] Migrating etcd to cluster mode...');
      const migrateStart = Date.now();
      await migrateToCluster(joinData.clusterConfig);
      console.log(`[Cluster] Migration complete in ${Date.now() - migrateStart}ms`);

      // Update ETCD hosts to point to all cluster members
      if (joinData.clusterConfig.memberClientUrls && joinData.clusterConfig.memberClientUrls.length > 0) {
        updateEtcdHosts(joinData.clusterConfig.memberClientUrls);
      }

      // Save etcd auth credentials from master node for authenticated connection
      if (joinData.clusterConfig.authUsername && joinData.clusterConfig.authPassword) {
        try {
          const fs = await import('fs');
          const path = await import('path');
          const authDir = path.join('/mnt/backup', '__system__', 'etcd');
          if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
          fs.writeFileSync(path.join(authDir, 'auth.json'), JSON.stringify({
            username: joinData.clusterConfig.authUsername,
            password: joinData.clusterConfig.authPassword,
          }, null, 2));
          reconnectEtcd();
        } catch (e) {
          console.warn('[Cluster] Failed to save etcd auth credentials:', e.message);
        }
      }

      // Save keepalived VRRP password from primary node for DNS VIP failover
      if (joinData.clusterConfig.keepalivedPassword) {
        try {
          await etcd.put('__system__/keepalived/password').value(joinData.clusterConfig.keepalivedPassword);
          console.log('[Cluster] Keepalived VRRP password saved.');
        } catch (e) {
          console.warn('[Cluster] Failed to save keepalived password:', e.message);
        }
      }

      // Wait for clustered etcd to become reachable
      console.log('[Cluster] Waiting for clustered ETCD...');
      await waitForEtcd(30, 2000);

      // Unseal with the provided password to decrypt DEK and JWT secret from cluster ETCD
      await unsealNode(password);
      JWT_SECRET = getJwtSecret();
      if (!JWT_SECRET) {
        JWT_SECRET = await getOrCreateJwtSecret();
      }

      // Register this node with the clustered etcd
      await registerLocalNode(nodeId, nodeName, nodeIp, clientIp);
      await bootCluster(nodeId);
      logEvent('security', 'info', 'System initialized (join)', { nodeId, nodeName, primaryIp });
    } else if (mode === 'restore') {
      const snapshotFile = req.file;
      if (!snapshotFile) throw new Error('Missing snapshot file');

      await restoreSystem(snapshotFile.path, password);
      JWT_SECRET = getJwtSecret();
      if (!JWT_SECRET) {
        JWT_SECRET = await getOrCreateJwtSecret();
      }
      await registerLocalNode(nodeId, nodeName, nodeIp, clientIp);
      await bootCluster(nodeId);

      await performPostRestoreMigration();
      logEvent('security', 'info', 'System initialized (restore)', { nodeId, nodeName });
    }

    const token = await signToken({ nodeId, role: 'admin' }, JWT_SECRET);
    res.cookie('token', token, { httpOnly: true, secure: req.secure, sameSite: 'strict' });

    res.json({ success: true });

    // Clear brute force tracking on successful setup
    await clearBruteForce(clientIp).catch(() => {});
  } catch (e) {
    // Record failed attempt for brute force tracking
    await recordFailedAttempt(req.ip).catch(() => {});
    res.status(400).json({ error: e.message, code: 'SETUP_FAILED' });
  }
});

app.post('/api/system/join', async (req, res) => {
  try {
    const clientIp = req.ip;
    const { name, ip, clientIp: joinClientIp } = req.body;
    console.log(`[Join] Request from ${clientIp}: node=${name}, ip=${ip}, clientIp=${joinClientIp}`);

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.warn(`[Join] Missing/invalid auth header from ${clientIp}`);
      return res.status(401).json({ error: 'Missing or invalid join token', code: 'AUTH_REQUIRED' });
    }

    const joinToken = authHeader.split(' ')[1];
    try {
      await verifyMasterPassword(joinToken);
      console.log(`[Join] Password verified for ${name}`);
    } catch (e) {
      console.warn(`[Join] Invalid master password from ${clientIp}: ${e.message}`);
      return res.status(403).json({ error: 'Invalid master password', code: 'JOIN_FORBIDDEN' });
    }

    console.log(`[Join] Adding etcd member: ${name} at ${ip}:2380`);
    const clusterInfo = await addEtcdMember(name, ip);
    console.log(`[Join] etcd member added: ${name} ready to join`);

    const id = uuidv4();
    await saveNode(id, name, ip, 'online', joinClientIp);

    // Ensure the joining node's client URL is in the list
    const selfClientUrl = `http://${ip}:2379`;
    const allUrls = clusterInfo.allClientUrls || [];
    if (!allUrls.find(u => u.includes(ip))) {
      allUrls.push(selfClientUrl);
    }

    // Read keepalived password to share with joining node
    let keepalivedPassword;
    try {
      keepalivedPassword = await etcd.get('__system__/keepalived/password').string();
    } catch (e) {
      console.warn('[Join] Could not read keepalived password:', e.message);
    }

    console.log(`[Join] Returning cluster config to ${name}: ${clusterInfo.initialCluster}`);
    res.json({
      success: true,
      id,
      clusterConfig: {
        memberName: clusterInfo.memberName,
        initialCluster: clusterInfo.initialCluster,
        initialClusterState: clusterInfo.initialClusterState,
        memberClientUrls: allUrls,
        clusterToken: clusterInfo.clusterToken,
        authUsername: clusterInfo.authUsername,
        authPassword: clusterInfo.authPassword,
        keepalivedPassword,
      },
    });
  } catch (e) {
    res.status(400).json({ error: e.message, code: 'JOIN_FAILED' });
  }
});



app.post('/api/system/unseal', async (req, res) => {
  try {
    const clientIp = req.ip;
    const bf = await checkBruteForce(clientIp);
    if (bf?.locked) {
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${bf.remainingMin} minutes.`, code: 'BRUTE_LOCKED' });
    }

    const { password } = req.body;

    await unsealNode(password);
    JWT_SECRET = getJwtSecret();
    if (!JWT_SECRET) {
      // Fallback for backward compat — shouldn't happen with new unseal
      JWT_SECRET = await getOrCreateJwtSecret();
    }
    await registerLocalNode(nodeId, nodeName, nodeIp);
    await bootCluster(nodeId);
    logEvent('security', 'info', 'Node unsealed', { nodeId, nodeName });

    // Revoke any previous sessions for this node
    await revokeAllSessions(nodeId).catch(e => console.warn('[Session] Failed to revoke prior sessions:', e.message));

    const token = await signToken({ nodeId, role: 'admin' }, JWT_SECRET);
    res.cookie('token', token, { httpOnly: true, secure: req.secure, sameSite: 'strict' });

    res.json({ success: true });

    await clearBruteForce(clientIp).catch(() => {});
  } catch (e) {
    await recordFailedAttempt(req.ip).catch(() => {});
    res.status(400).json({ error: e.message, code: 'UNSEAL_FAILED' });
  }
});

app.post('/api/system/logout', requireAuth, async (req, res) => {
  if (req.user?.jti) {
    await blacklistToken(req.user.jti).catch(e => console.warn('[Auth] Failed to blacklist token on logout:', e.message));
  }
  res.clearCookie('token');
  res.json({ success: true });
});

app.post('/api/system/change-password', requireAuth, requireUnsealed, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    await changeMasterPassword(currentPassword, newPassword);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message, code: 'PASSWORD_CHANGE_FAILED' });
  }
});

app.post('/api/system/rotate-dek', requireAuth, requireUnsealed, async (req, res) => {
  try {
    const { masterPassword } = req.body;
    await rotateDEK(masterPassword);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message, code: 'DEK_ROTATE_FAILED' });
  }
});

app.post('/api/system/session/refresh', requireAuth, async (req, res) => {
  try {
    const oldToken = req.cookies.token;
    if (!oldToken) return res.status(401).json({ error: 'No session token', code: 'AUTH_REQUIRED' });

    const newToken = await refreshToken(oldToken, JWT_SECRET);
    if (!newToken) return res.status(401).json({ error: 'Session expired or revoked', code: 'SESSION_EXPIRED' });

    res.cookie('token', newToken, { httpOnly: true, secure: req.secure, sameSite: 'strict' });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message, code: 'REFRESH_FAILED' });
  }
});

const stopSystemContainers = async () => {
  console.log('Stopping and removing system containers and networks...');
  try {
    const containers = await docker.listContainers({ all: true });
    const cleanup = containers
      .filter(c => c.Names[0].startsWith('/core-docker-') && c.Names[0] !== '/core-docker-backend' && c.Names[0] !== '/core-docker-frontend')
      .map(async c => {
        console.log(`Cleaning up container ${c.Names[0]}...`);
        try {
          const container = docker.getContainer(c.Id);
          await Promise.race([
            container.stop(),
            new Promise(r => setTimeout(r, 5000))
          ]);
          await container.remove({ force: true });
        } catch(e) {
          console.warn(`Failed to clean up ${c.Names[0]}: ${e.message}`);
        }
      });
    await Promise.all(cleanup);

    const networks = await docker.listNetworks();
    const netCleanup = networks
      .filter(n => n.Name === 'web-proxy' || n.Name.startsWith('group-'))
      .map(async n => {
        console.log(`Cleaning up network ${n.Name}...`);
        try {
          await docker.getNetwork(n.Id).remove();
        } catch(e) {
          console.error(`Failed to remove network ${n.Name}: ${e.message}`);
        }
      });
    await Promise.all(netCleanup);
  } catch (e) {
    console.error('Error cleaning up system resources:', e.message);
  }
};

const shutdown = (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`${signal} received. Shutting down gracefully...`);

  // Hard safety net: exit no matter what. Must NOT use unref() — the timer
  // keeps the event loop alive until cleanup starts its Docker API calls.
  const hardExit = setTimeout(() => {
    console.error('Shutdown timed out — forcing exit.');
    process.exit(1);
  }, 55000);

  (async () => {
    try {
      stopScheduler();
      stopOrchestrator();
      stopReconciler();
      await stopSystemContainers();
      try { await closeEtcd(); } catch {}
    } catch (e) {
      console.error('Error during shutdown:', e.message);
    } finally {
      clearTimeout(hardExit);
      process.exit(0);
    }
  })();
};

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled rejection:', reason?.message || reason);
  // Don't crash — log and degrade. The etcd circuit breaker can trigger
  // rejections in setInterval callbacks, which should be handled, not fatal.
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const startBackend = async () => {
  try {
    const etcdStarted = await bootstrapEtcd();
    if (!etcdStarted) {
      console.log('[Cluster] Failed to bootstrap ETCD.');
      return;
    }

    // Reconnect etcd with auth credentials (bootstrapEtcd may have enabled auth)
    reconnectEtcd();

    console.log('[Cluster] Waiting for ETCD to become reachable...');
    await waitForEtcd();

    await registerLocalNode(nodeId, nodeName, nodeIp);

    await bootstrapNginx();

    if (!isNodeSealed()) {
      await bootCluster(nodeId);
    } else {
      console.log('[Cluster] Node is sealed. Waiting for manual unseal.');
    }
  } catch (e) {
    console.error(`Startup failed: ${e.message}`);
    console.log('Retrying bootstrap in 5 seconds...');
    setTimeout(startBackend, 5000);
  }
};

app.listen(port, '0.0.0.0', async () => {
  console.log(`Backend running on port ${port} (Node: ${nodeName}, ID: ${nodeId}, IP: ${nodeIp})`);
  await startBackend();
});