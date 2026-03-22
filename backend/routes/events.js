import express from 'express';
import docker from '../services/docker.js';
import { getNodes } from '../services/db.js';
import { generateClusterToken } from '../services/secrets.js';

const router = express.Router();

router.get('/', async (req, res) => {
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
  const remoteReaders = [];

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

  // 1. Get local events
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

    // 2. Proxy events from other nodes if this is not a cluster internal request
    if (!req.clusterNode) {
      (async () => {
        try {
          const nodes = await getNodes();
          for (const node of nodes) {
            if (node.id === (process.env.NODE_ID || 'master')) continue;
            const token = generateClusterToken({ node: process.env.NODE_ID });
            const resp = await fetch(`http://${node.ip}:${process.env.PORT || 3000}/events`, {
              headers: { 'Authorization': `Bearer ${token}` }
            });
            if (resp.body) {
              const reader = resp.body.getReader();
              remoteReaders.push(reader);
              (async () => {
                const decoder = new TextDecoder();
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  res.write(value);
                }
              })().catch(() => {});
            }
          }
        } catch (e) {
          console.error('[Events Proxy] Failed to fetch remote nodes:', e.message);
        }
      })();
    }

    req.on('close', () => {
      stream.destroy && stream.destroy();
      statsStreams.forEach(s => s.destroy && s.destroy());
      statsStreams.clear();
      remoteReaders.forEach(r => r.cancel && r.cancel());
    });
  });
});

export default router;
