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
import docker from './services/docker.js';

const app = express();
const port = process.env.PORT || 3000;

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
  console.log('Stopping system containers...');
  try {
    const containers = await docker.listContainers();
    for (const c of containers) {
      if (c.Names[0].startsWith('/core-docker-') && c.Names[0] !== '/core-docker-backend') {
        console.log(`Stopping ${c.Names[0]}...`);
        try { await docker.getContainer(c.Id).stop(); } catch(e) {}
      }
    }
  } catch (e) {
    console.error('Error stopping system containers:', e.message);
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
  console.log(`Backend running on port ${port}`);
  try {
    await bootstrapEtcd();
    await waitForEtcd();
    await reconcileContainers();
    startScheduler();
  } catch (e) {
    console.error(`Startup failed: ${e.message}`);
    process.exit(1);
  }
});
