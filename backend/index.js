import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
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
import {closeEtcd, registerLocalNode, waitForEtcd, saveNode, updateEtcdHosts} from './services/db.js';
import {startScheduler, stopScheduler} from './services/scheduler.js';
import {startOrchestrator, stopOrchestrator} from './services/orchestrator.js';
import {bootstrapNginx, getNodeUrl} from './services/nginx.js';
import {startLogger} from './services/logger.js';
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
  getOrCreateJwtSecret,
} from './services/secrets.js';

const app = express();
const port = process.env.PORT || 3000;

// Trust the first reverse proxy (nginx) so req.ip returns the real client IP
// and express-rate-limit correctly identifies individual clients.
app.set('trust proxy', 1);

let JWT_SECRET = null;
const nodeId = process.env.NODE_ID || uuidv4();
const nodeName = process.env.NODE_NAME || 'node-1';
const nodeIp = process.env.NODE_IP || '127.0.0.1';
const clientIp = process.env.NODE_CLIENT_IP || nodeIp;
let clusterBooted = false;

app.use(helmet());
app.use(cookieParser());
app.use(express.json());

app.use(cors({
  origin: process.env.CORS_ORIGIN || true,
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
    await reconcileContainers(nodeId);
    startScheduler();
    startOrchestrator(nodeId);
    startReconciler(nodeId);
    clusterBooted = true;
    console.log('[Cluster] Services started successfully.');
    await runMigrations(migrations);
  } catch (e) {
    console.error(`[Cluster] Boot failed: ${e.message}`);
  }
};

const requireAuth = (req, res, next) => {
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
    }
  }

  if (!token) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
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

app.use('/api/containers', requireAuth, requireUnsealed, containerRoutes);
app.use('/api/info', requireAuth, infoRoutes);
app.use('/api/events', requireAuth, eventRoutes);
app.use('/api/nodes', requireAuth, nodeRoutes);
app.use('/api/secrets', requireAuth, requireUnsealed, secretRoutes);
app.use('/api/tasks', requireAuth, requireUnsealed, taskRoutes);
app.use('/api/settings', requireAuth, requireUnsealed, settingsRoutes);
app.use('/api/groups', requireAuth, requireUnsealed, groupRoutes);

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
    nodeId: (authenticated || !initialized) ? nodeId : undefined,
    nodeName: (authenticated || !initialized) ? nodeName : undefined,
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
  const backupPath = process.env.HOST_BACKUP_PATH || '/data/backup';
  const destPath = `${backupPath}/${SYSTEM_NAMESPACE}/etcd-snapshot-restore.db`;
  fs.writeFileSync(destPath, snapshotData);
  console.log('Snapshot copied to', destPath);
  await initializeSystem(password);
}

const upload = multer({ dest: '/tmp/uploads/' });

app.post('/api/system/setup', upload.single('snapshotFile'), async (req, res) => {
  try {
    const { mode, password, primaryIp, joinToken } = req.body;

    if (!JWT_SECRET) {
      JWT_SECRET = await getOrCreateJwtSecret();
    }

    if (mode === 'create' || !mode) {
      await initializeSystem(password);
      await registerLocalNode(nodeId, nodeName, nodeIp, clientIp);
      await bootCluster(nodeId);
    } else if (mode === 'join') {
      const joinRes = await fetch(`${getNodeUrl(primaryIp)}/api/system/join`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${joinToken}`,
        },
        body: JSON.stringify({ name: nodeName, ip: nodeIp, clientIp }),
      });
      if (!joinRes.ok) {
        throw new Error('Failed to join cluster: ' + await joinRes.text());
      }

      const joinData = await joinRes.json();

      if (!joinData.clusterConfig) {
        // Legacy leader — no cluster config returned, fall through
        return res.json({ success: true, joined: true, data: joinData });
      }

      // Migrate local etcd from standalone to clustered
      console.log('[Cluster] Migrating etcd to cluster mode...');
      await migrateToCluster(joinData.clusterConfig);

      // Update ETCD hosts to point to all cluster members
      if (joinData.clusterConfig.memberClientUrls && joinData.clusterConfig.memberClientUrls.length > 0) {
        updateEtcdHosts(joinData.clusterConfig.memberClientUrls);
      }

      // Wait for clustered etcd to become reachable
      console.log('[Cluster] Waiting for clustered ETCD...');
      await waitForEtcd(30, 2000);

      // Register this node with the clustered etcd
      await registerLocalNode(nodeId, nodeName, nodeIp, clientIp);
      await bootCluster(nodeId);
    } else if (mode === 'restore') {
      const snapshotFile = req.file;
      if (!snapshotFile) throw new Error('Missing snapshot file');

      await restoreSystem(snapshotFile.path, password);
      await registerLocalNode(nodeId, nodeName, nodeIp, clientIp);
      await bootCluster(nodeId);

      await performPostRestoreMigration();
    }

    const token = jwt.sign({ nodeId, role: 'admin' }, JWT_SECRET, { expiresIn: '8h' });
    res.cookie('token', token, { httpOnly: true, secure: req.secure, sameSite: 'strict' });

    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message, code: 'SETUP_FAILED' });
  }
});

app.post('/api/system/join', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid join token', code: 'AUTH_REQUIRED' });
    }

    const { name, ip, clientIp: joinClientIp } = req.body;

    const clusterInfo = await addEtcdMember(name, ip);

    const id = uuidv4();
    await saveNode(id, name, ip, 'online', joinClientIp);

    // Ensure the joining node's client URL is in the list
    const selfClientUrl = `http://${ip}:2379`;
    const allUrls = clusterInfo.allClientUrls || [];
    if (!allUrls.find(u => u.includes(ip))) {
      allUrls.push(selfClientUrl);
    }

    res.json({
      success: true,
      id,
      clusterConfig: {
        memberName: clusterInfo.memberName,
        initialCluster: clusterInfo.initialCluster,
        initialClusterState: clusterInfo.initialClusterState,
        memberClientUrls: allUrls,
      },
    });
  } catch (e) {
    res.status(400).json({ error: e.message, code: 'JOIN_FAILED' });
  }
});

app.post('/api/system/unseal', async (req, res) => {
  try {
    const { password } = req.body;

    if (!JWT_SECRET) {
      JWT_SECRET = await getOrCreateJwtSecret();
    }

    await unsealNode(password);
    await registerLocalNode(nodeId, nodeName, nodeIp);
    await bootCluster(nodeId);

    const token = jwt.sign({ nodeId, role: 'admin' }, JWT_SECRET, { expiresIn: '8h' });
    res.cookie('token', token, { httpOnly: true, secure: req.secure, sameSite: 'strict' });

    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message, code: 'UNSEAL_FAILED' });
  }
});

app.post('/api/system/logout', (req, res) => {
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

const stopSystemContainers = async () => {
  console.log('Stopping and removing system containers and networks...');
  try {
    const containers = await docker.listContainers({ all: true });
    for (const c of containers) {
      if (c.Names[0].startsWith('/core-docker-') && c.Names[0] !== '/core-docker-backend') {
        console.log(`Cleaning up container ${c.Names[0]}...`);
        try {
          const container = docker.getContainer(c.Id);
          await container.stop();
          await container.remove();
        } catch(e) {}
      }
    }

    const networks = await docker.listNetworks();
    for (const n of networks) {
      // Only clean up dynamically-created networks. app-net is managed
      // by docker-compose and will be removed when the stack goes down.
      if (n.Name === 'web-proxy' || n.Name.startsWith('group-')) {
        console.log(`Cleaning up network ${n.Name}...`);
        try {
          const network = docker.getNetwork(n.Id);
          await network.remove();
        } catch(e) {
          console.error(`Failed to remove network ${n.Name}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    console.error('Error cleaning up system resources:', e.message);
  }
};

const shutdown = async (signal) => {
  console.log(`${signal} received. Shutting down gracefully...`);
  stopScheduler();
  stopOrchestrator();
  stopReconciler();
  await stopSystemContainers();
  closeEtcd();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const startBackend = async () => {
  try {
    const etcdStarted = await bootstrapEtcd();
    if (!etcdStarted) {
      console.log('[Cluster] Failed to bootstrap ETCD.');
      return;
    }

    console.log('[Cluster] Waiting for ETCD to become reachable...');
    await waitForEtcd();

    JWT_SECRET = await getOrCreateJwtSecret();

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