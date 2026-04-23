import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import containerRoutes from './routes/containers.js';
import infoRoutes from './routes/info.js';
import eventRoutes from './routes/events.js';
import nodeRoutes from './routes/nodes.js';
import secretRoutes from './routes/secrets.js';
import taskRoutes from './routes/tasks.js';
import settingsRoutes from './routes/settings.js';
import groupRoutes from './routes/groups.js';
import {reconcileContainers} from './services/reconciler.js';
import {bootstrapEtcd, addEtcdMember} from './services/etcd-cluster.js';
import {closeEtcd, registerLocalNode, waitForEtcd, saveNode} from './services/db.js';
import {startScheduler, stopScheduler} from './services/scheduler.js';
import {startOrchestrator, stopOrchestrator} from './services/orchestrator.js';
import {bootstrapNginx} from './services/nginx.js';
import {startLogger} from './services/logger.js';
import docker from './services/docker.js';
import {v4 as uuidv4} from 'uuid';
import {
  changeMasterPassword,
  initializeSystem,
  isNodeSealed,
  isSystemInitialized,
  rotateDEK,
  unsealNode,
  verifyClusterToken,
} from './services/secrets.js';

const app = express();
const port = process.env.PORT || 3000;

// Use a random secret for the JWT to ensure sessions are invalidated on restart
const JWT_SECRET = crypto.randomBytes(64).toString('hex');

const nodeId = process.env.NODE_ID || uuidv4();
const nodeName = process.env.NODE_NAME || 'node-1';

const nodeIp = process.env.NODE_IP || '127.0.0.1';

app.use(helmet());
app.use(cookieParser());
app.use(express.json());

let clusterBooted = false;

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
    clusterBooted = true;
    console.log('[Cluster] Services started successfully.');
  } catch (e) {
    console.error(`[Cluster] Boot failed: ${e.message}`);
  }
};

// Auth Middleware
const requireAuth = (req, res, next) => {
  const token = req.cookies.token;
  const authHeader = req.headers.authorization;

  // Check for cluster token first
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const clusterToken = authHeader.split(' ')[1];
    try {
      req.clusterNode = verifyClusterToken(clusterToken);
      return next();
    } catch (err) {
      // Fall through to regular cookie check
    }
  }

  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
};

// Unseal Middleware
const requireUnsealed = (req, res, next) => {
  if (isNodeSealed()) {
    return res.status(423).json({
      error: 'Node is sealed',
      nodeId,
      nodeName,
      sealed: true
    });
  }
  next();
};

// Routes
app.use('/containers', requireAuth, requireUnsealed, containerRoutes);
app.use('/info', requireAuth, infoRoutes);
app.use('/events', requireAuth, eventRoutes);
app.use('/nodes', requireAuth, nodeRoutes);
app.use('/secrets', requireAuth, requireUnsealed, secretRoutes);
app.use('/tasks', requireAuth, requireUnsealed, taskRoutes);
app.use('/settings', requireAuth, settingsRoutes);
app.use('/groups', requireAuth, groupRoutes);

// Unseal/Setup Routes
app.get('/system/status', async (req, res) => {
  let authenticated = false;
  if (req.cookies.token) {
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
    // Only leak node specific details if authenticated or system is not yet initialized
    nodeId: (authenticated || !initialized) ? nodeId : undefined,
    nodeName: (authenticated || !initialized) ? nodeName : undefined
  });
});

import multer from 'multer';

async function performPostRestoreMigration() {
  const { getContainers, saveContainer } = await import('./services/db.js');
  const containers = await getContainers();
  
  for (const c of containers) {
    if (c.ha && c.ha_allowed_nodes && c.ha_allowed_nodes.length > 0) {
      c.status = 'error: missing-pinned-node';
    } else {
      c.status = 'stopped';
    }
    await saveContainer(c.id, c.name, c.config, c.status, null, null);
  }
}

async function restoreSystem(snapshotPath, password) {
  console.log('Restoring from snapshot:', snapshotPath);
  await initializeSystem(password); // mock for now
}

const upload = multer({ dest: '/tmp/uploads/' });

app.post('/system/setup', upload.single('snapshotFile'), async (req, res) => {
  try {
    const { mode, password, primaryIp, joinToken } = req.body;
    
    if (mode === 'create' || !mode) {
      await initializeSystem(password);
      await registerLocalNode(nodeId, nodeName, nodeIp);
      await bootCluster(nodeId);
    } else if (mode === 'join') {
      // call primary node to join
      const joinRes = await fetch(`http://${primaryIp}:8000/system/join`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${joinToken}`
        },
        body: JSON.stringify({ name: nodeName, ip: nodeIp })
      });
      if (!joinRes.ok) {
        throw new Error('Failed to join cluster: ' + await joinRes.text());
      }
      
      const joinData = await joinRes.json();
      
      // We would then need to start our own ETCD connecting to the primary
      // Then boot cluster.
      // await registerLocalNode(nodeId, nodeName, nodeIp);
      // await bootCluster(nodeId);
      
      return res.json({ success: true, joined: true, data: joinData });
    } else if (mode === 'restore') {
      const snapshotFile = req.file;
      if (!snapshotFile) throw new Error('Missing snapshot file');
      
      // 1. Verify password against the snapshot
      // 2. Execute restore with --force-new-cluster
      // 3. Overwrite the ETCD named volume
      // 4. Reboot the cluster
      
      await restoreSystem(snapshotFile.path, password);
      await registerLocalNode(nodeId, nodeName, nodeIp);
      await bootCluster(nodeId);
      
      // Post-restore migration
      await performPostRestoreMigration();
    }

    const token = jwt.sign({ nodeId, role: 'admin' }, JWT_SECRET, { expiresIn: '8h' });
    res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' });
    
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/system/join', async (req, res) => {
  // This is called by a new node on the primary node
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid join token' });
    }

    const { name, ip } = req.body;

    // Add member to ETCD
    const etcdRes = await addEtcdMember(name, ip);

    // Save to DB
    const id = uuidv4();
    await saveNode(id, name, ip, 'online');

    res.json({ success: true, etcdRes, id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/system/unseal', async (req, res) => {
  try {
    const { password } = req.body;
    await unsealNode(password);
    await registerLocalNode(nodeId, nodeName, nodeIp);
    await bootCluster(nodeId);

    const token = jwt.sign({ nodeId, role: 'admin' }, JWT_SECRET, { expiresIn: '8h' });
    res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' });
    
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/system/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

app.post('/system/change-password', requireAuth, requireUnsealed, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    await changeMasterPassword(currentPassword, newPassword);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/system/rotate-dek', requireAuth, requireUnsealed, async (req, res) => {
  try {
    const { masterPassword } = req.body;
    await rotateDEK(masterPassword);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
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
      if (n.Name === 'backhaul' || n.Name === 'web-proxy' || n.Name.startsWith('group-')) {
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

process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  stopScheduler();
  stopOrchestrator();
  closeEtcd();
  await stopSystemContainers();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received. Shutting down gracefully...');
  stopScheduler();
  stopOrchestrator();
  closeEtcd();
  await stopSystemContainers();
  process.exit(0);
});

const startBackend = async () => {
  try {
    const etcdStarted = await bootstrapEtcd();
    if (!etcdStarted) {
      console.log('[Cluster] Failed to bootstrap ETCD.');
      return;
    }
    
    // Wait for ETCD to become reachable
    console.log('[Cluster] Waiting for ETCD to become reachable...');
    await waitForEtcd();
    await registerLocalNode(nodeId, nodeName, nodeIp);
    
    // Boot Nginx early so unseal UI is available securely over HTTPS
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
