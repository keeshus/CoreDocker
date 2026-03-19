import express from 'express';
import containerRoutes from './routes/containers.js';
import infoRoutes from './routes/info.js';
import eventRoutes from './routes/events.js';
import nodeRoutes from './routes/nodes.js';
import secretRoutes from './routes/secrets.js';
import taskRoutes from './routes/tasks.js';
import settingsRoutes from './routes/settings.js';
import { reconcileContainers } from './services/reconciler.js';
import { bootstrapEtcd } from './services/etcd-cluster.js';
import { waitForEtcd } from './services/db.js';
import { startScheduler } from './services/scheduler.js';
import { startOrchestrator } from './services/orchestrator.js';
import docker from './services/docker.js';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { registerLocalNode } from './services/db.js';

const app = express();
const port = process.env.PORT || 3000;

const nodeId = process.env.NODE_ID || uuidv4();
const nodeName = process.env.NODE_NAME || os.hostname();

const getLocalIp = () => {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.family === 'IPv4') {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
};

const nodeIp = getLocalIp();

app.use(express.json());

// Routes
app.use('/containers', containerRoutes);
app.use('/info', infoRoutes);
app.use('/events', eventRoutes);
app.use('/nodes', nodeRoutes);
app.use('/secrets', secretRoutes);
app.use('/tasks', taskRoutes);
app.use('/settings', settingsRoutes);

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
  await stopSystemContainers();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await stopSystemContainers();
  process.exit(0);
});

app.listen(port, async () => {
  console.log(`Backend running on port ${port} (Node: ${nodeName}, ID: ${nodeId}, IP: ${nodeIp})`);
  try {
    await bootstrapEtcd();
    await waitForEtcd();
    await registerLocalNode(nodeId, nodeName, nodeIp);
    await reconcileContainers(nodeId);
    startScheduler();
    startOrchestrator(nodeId);
  } catch (e) {
    console.error(`Startup failed: ${e.message}`);
    process.exit(1);
  }
});
