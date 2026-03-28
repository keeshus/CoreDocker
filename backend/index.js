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
import {bootstrapEtcd} from './services/etcd-cluster.js';
import {closeEtcd, registerLocalNode, waitForEtcd} from './services/db.js';
import {startScheduler, stopScheduler} from './services/scheduler.js';
import {startOrchestrator, stopOrchestrator} from './services/orchestrator.js';
import {bootstrapNginx} from './services/nginx.js';
import {startLogger, stopLogger} from './services/logger.js';
import docker from './services/docker.js';
import {v4 as uuidv4} from 'uuid';
import {
  changeMasterPassword,
  initializeSystem,
  isNodeUnsealed,
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
  if (!isNodeUnsealed()) {
    console.log('[Cluster] Cannot boot: Node is sealed.');
    return;
  }
  console.log('[Cluster] Booting services...');
  try {
    startLogger();
    await bootstrapNginx();
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
  if (!isNodeUnsealed()) {
    return res.status(423).json({
      error: 'Node is sealed',
      nodeId,
      nodeName,
      unsealed: false
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

  res.json({
    initialized: await isSystemInitialized(),
    unsealed: isNodeUnsealed(),
    authenticated,
    nodeId,
    nodeName
  });
});

app.post('/system/setup', async (req, res) => {
  try {
    const { password, backupPath, nonBackupPath } = req.body;
    await initializeSystem(password, backupPath, nonBackupPath);
    await registerLocalNode(nodeId, nodeName, nodeIp);
    await bootCluster(nodeId);

    const token = jwt.sign({ nodeId, role: 'admin' }, JWT_SECRET, { expiresIn: '8h' });
    res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' });
    
    res.json({ success: true });
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
  console.log('Stopping and removing system containers...');
  try {
    const containers = await docker.listContainers({ all: true });
    for (const c of containers) {
      if (c.Names[0].startsWith('/core-docker-') && c.Names[0] !== '/core-docker-backend') {
        console.log(`Cleaning up ${c.Names[0]}...`);
        try {
          const container = docker.getContainer(c.Id);
          await container.stop();
          await container.remove();
        } catch(e) {}
      }
    }
  } catch (e) {
    console.error('Error cleaning up system containers:', e.message);
  }
};

process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  stopScheduler();
  stopOrchestrator();
  await stopSystemContainers();
  closeEtcd();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received. Shutting down gracefully...');
  stopScheduler();
  stopOrchestrator();
  await stopSystemContainers();
  closeEtcd();
  process.exit(0);
});

app.listen(port, '0.0.0.0', async () => {
  console.log(`Backend running on port ${port} (Node: ${nodeName}, ID: ${nodeId}, IP: ${nodeIp})`);
  try {
    await bootstrapEtcd();
    await waitForEtcd();
    await registerLocalNode(nodeId, nodeName, nodeIp);
    
    if (isNodeUnsealed()) {
      await bootCluster(nodeId);
    } else {
      console.log('[Cluster] Node is sealed. Waiting for manual unseal.');
    }
  } catch (e) {
    console.error(`Startup failed: ${e.message}`);
    process.exit(1);
  }
});
