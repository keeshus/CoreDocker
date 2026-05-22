import express from 'express';
import docker from '../services/docker.js';
import { getNodes } from '../services/db.js';
import { generateClusterToken } from '../services/secrets.js';
import { getNodeUrl } from '../services/nginx.js';

const router = express.Router();

// Track active SSE connections per client IP
const connectionsByIp = new Map();
const MAX_CONNECTIONS_PER_IP = 5;
// Track remote proxy connections per target node (max 1 per node)
const remoteProxyTargets = new Set();

function trackConnection(ip, res) {
  let conns = connectionsByIp.get(ip);
  if (!conns) {
    conns = new Set();
    connectionsByIp.set(ip, conns);
  }
  conns.add(res);
}

function untrackConnection(ip, res) {
  const conns = connectionsByIp.get(ip);
  if (!conns) return;
  conns.delete(res);
  if (conns.size === 0) connectionsByIp.delete(ip);
}

router.get('/', async (req, res) => {
  const clientIp = req.ip;

  // Enforce max concurrent connections per client IP
  const existing = connectionsByIp.get(clientIp);
  if (existing && existing.size >= MAX_CONNECTIONS_PER_IP) {
    return res.status(429).json({ error: 'Too many concurrent event connections', code: 'SSE_LIMIT' });
  }

  // Enforce max 1 remote proxy connection per target node
  if (req.clusterNode && remoteProxyTargets.has(clientIp)) {
    return res.status(429).json({ error: 'Remote proxy already connected for this node', code: 'SSE_PROXY_LIMIT' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) {}
  };

  sendEvent({ type: 'connected' });

  // Track this connection
  trackConnection(clientIp, res);
  if (req.clusterNode) remoteProxyTargets.add(clientIp);

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
            const resp = await fetch(`${getNodeUrl(node.ip)}/api/events`, {
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
      untrackConnection(clientIp, res);
      if (req.clusterNode) remoteProxyTargets.delete(clientIp);
    });
  });
});

export default router;
