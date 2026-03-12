import express from 'express';
import docker from '../services/docker.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    const enrichedContainers = await Promise.all(containers.map(async (c) => {
      try {
        const container = docker.getContainer(c.Id);
        const inspect = await container.inspect();
        // If state is not running and there is an error in the last exit, or if it failed to start
        return { ...c, StateDetails: inspect.State };
      } catch (e) {
        return c;
      }
    }));
    res.json(enrichedContainers);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch containers', details: error.message });
  }
});

router.get('/:id/logs', (req, res) => {
  const containerId = req.params.id;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const container = docker.getContainer(containerId);
  container.logs({ follow: true, stdout: true, stderr: true, tail: 100 }, (err, stream) => {
    if (err) return res.end();
    stream.on('data', (chunk) => {
      const cleanLine = chunk.toString('utf8', 8);
      res.write(`data: ${JSON.stringify({ log: cleanLine })}\n\n`);
    });
    req.on('close', () => stream.destroy && stream.destroy());
  });
});

export default router;
