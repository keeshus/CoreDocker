import express from 'express';
import { getNodes, saveNode, deleteNode } from '../services/db.js';
import { logEvent } from '../services/logger.js';
import docker from '../services/docker.js';

const router = express.Router();
const DNS_SAFE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// Returns etcd cluster member status (learner/voting) merged with node info.
// Each member lists: name, peerUrl, clientUrl, isLearner, id (hex)
router.get('/etcd-status', async (req, res) => {
  try {
    const nodes = await getNodes();
    const { execSync } = await import('child_process');
    let members = [];
    try {
      const { readFileSync } = await import('fs');
      const authPath = '/mnt/backup/__system__/etcd/auth.json';
      let authArgs = '';
      try {
        const auth = JSON.parse(readFileSync(authPath, 'utf8'));
        if (auth.username && auth.password) authArgs = `--user ${auth.username}:${auth.password}`;
      } catch {}
      const out = execSync(
        `docker exec core-docker-etcd etcdctl --endpoints=127.0.0.1:2379 ${authArgs} member list 2>&1`,
        { encoding: 'utf8', timeout: 10000 }
      );
      for (const line of out.trim().split('\n')) {
        const cols = line.split(', ');
        if (cols.length >= 6) {
          members.push({
            id: cols[0],
            status: cols[1],
            name: cols[2],
            peerUrl: cols[3],
            clientUrl: cols[4],
            isLearner: cols[5] === 'true',
          });
        }
      }
    } catch (e) {
      console.warn('[Nodes] Failed to get etcd member list:', e.message);
    }

    // Check actual service health (running system containers via Dockerode)
    let runningContainers = [];
    try {
      const containers = await docker.listContainers({ all: false });
      runningContainers = containers.map(c => (c.Names?.[0] || '').replace(/^\//, ''));
    } catch (e) {
      console.warn('[Nodes] Failed to list Docker containers:', e.message);
    }
    const systemServices = ['core-docker-etcd', 'core-docker-backend', 'core-docker-proxy', 'core-docker-coredns'];
    const healthSummary = {};
    for (const svc of systemServices) {
      healthSummary[svc] = runningContainers.includes(svc);
    }
    const allServicesHealthy = systemServices.every(s => healthSummary[s]);

    // Merge etcd member status and service health into each known node
    const enriched = nodes.map(node => {
      const member = members.find(m => m.name === node.name);
      return {
        ...node,
        etcd: member ? {
          isLearner: member.isLearner,
          status: member.status,
          id: member.id,
        } : { isLearner: null, status: 'unknown', id: null },
        services: healthSummary,
        allVoting: members.length > 0 && members.every(m => !m.isLearner),
      };
    });

    res.json({
      nodes: enriched,
      members,
      allVoting: members.every(m => !m.isLearner),
      allServicesHealthy,
      systemServices,
    });
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'ETCD_STATUS_FAILED' });
  }
});

router.get('/', async (req, res) => {
  try {
    const nodes = await getNodes();
    res.json(nodes);
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'NODES_LIST_FAILED' });
  }
});

router.put('/:id/rename', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Name is required', code: 'VALIDATION_ERROR' });
    }
    if (!DNS_SAFE_RE.test(name)) {
      return res.status(400).json({ error: 'Name must be lowercase alphanumeric with hyphens (DNS-safe)', code: 'VALIDATION_ERROR' });
    }
    const nodes = await getNodes();
    const node = nodes.find(n => n.id === req.params.id);
    if (!node) return res.status(404).json({ error: 'Node not found', code: 'NOT_FOUND' });

    node.name = name;
    await saveNode(node.id, node.name, node.ip, node.status, node.clientIp);
    logEvent('security', 'info', `Node ${req.params.id} renamed to ${name}`);
    res.json(node);
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'NODE_RENAME_FAILED' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await deleteNode(req.params.id);
    logEvent('security', 'info', `Node ${req.params.id} removed`);
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'NODE_DELETE_FAILED' });
  }
});

export default router;
