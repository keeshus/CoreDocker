import express from 'express';
import docker from '../services/docker.js';

const router = express.Router();

router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) {}
  };

  sendEvent({ type: 'connected' });

  const statsStreams = new Map();

  const startContainerStats = (containerId) => {
    if (statsStreams.has(containerId)) return;
    const container = docker.getContainer(containerId);
    container.stats({ stream: true }, (err, statsStream) => {
      if (err) return;
      statsStreams.set(containerId, statsStream);
      statsStream.on('data', (chunk) => {
        try {
          const stats = JSON.parse(chunk.toString());
          sendEvent({ type: 'container-stats', id: containerId, cpu: stats.cpu_stats, memory: stats.memory_stats });
        } catch (e) {}
      });
      statsStream.on('error', () => { if (statsStreams.get(containerId) === statsStream) statsStreams.delete(containerId); });
    });
  };

  const stopContainerStats = (containerId) => {
    const stream = statsStreams.get(containerId);
    if (stream) { stream.destroy && stream.destroy(); statsStreams.delete(containerId); }
  };

  docker.getEvents((err, stream) => {
    if (err) return;
    stream.on('data', (chunk) => {
      try {
        const event = JSON.parse(chunk.toString());
        if (event.Type === 'container') {
          sendEvent({ type: 'docker-event', action: event.Action, id: event.id, name: event.Actor.Attributes.name, status: event.status });
          if (event.Action === 'start') startContainerStats(event.id);
          else if (['stop', 'die', 'destroy'].includes(event.Action)) stopContainerStats(event.id);
        }
      } catch (e) {}
    });
    
    req.on('close', () => {
      stream.destroy && stream.destroy();
      statsStreams.forEach(s => s.destroy && s.destroy());
      statsStreams.clear();
    });
  });

  docker.listContainers({ all: false }).then(containers => containers.forEach(c => startContainerStats(c.Id)));
});

export default router;
