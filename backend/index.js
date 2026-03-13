import express from 'express';
import containerRoutes from './routes/containers.js';
import infoRoutes from './routes/info.js';
import eventRoutes from './routes/events.js';
import { reconcileContainers } from './services/reconciler.js';

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Routes
app.use('/containers', containerRoutes);
app.use('/info', infoRoutes);
app.use('/events', eventRoutes);

app.listen(port, async () => {
  console.log(`Backend running on port ${port}`);
  await reconcileContainers();
});
