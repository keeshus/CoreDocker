import express from 'express';
import containerRoutes from './routes/containers.js';
import infoRoutes from './routes/info.js';
import eventRoutes from './routes/events.js';
import nodeRoutes from './routes/nodes.js';
import secretRoutes from './routes/secrets.js';
import { reconcileContainers } from './services/reconciler.js';
import { bootstrapEtcd } from './services/etcd-cluster.js';
import { waitForEtcd } from './services/db.js';

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Routes
app.use('/containers', containerRoutes);
app.use('/info', infoRoutes);
app.use('/events', eventRoutes);
app.use('/nodes', nodeRoutes);
app.use('/secrets', secretRoutes);

app.listen(port, async () => {
  console.log(`Backend running on port ${port}`);
  try {
    await bootstrapEtcd();
    await waitForEtcd();
    await reconcileContainers();
  } catch (e) {
    console.error(`Startup failed: ${e.message}`);
    process.exit(1);
  }
});
