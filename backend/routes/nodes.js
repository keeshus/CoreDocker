import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getNodes, saveNode, deleteNode } from '../services/db.js';
import { addEtcdMember } from '../services/etcd-cluster.js';
import { logEvent } from '../services/logger.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const nodes = await getNodes();
    res.json(nodes);
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'NODES_LIST_FAILED' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, ip, clientIp } = req.body;
    if (!name || !ip) {
      return res.status(400).json({ error: 'Name and IP are required', code: 'VALIDATION_ERROR' });
    }
    if (!DNS_SAFE_RE.test(name)) {
      return res.status(400).json({ error: 'Name must be lowercase alphanumeric with hyphens (DNS-safe)', code: 'VALIDATION_ERROR' });
    }
    // Validate IP format before using in etcd peer URLs and system operations
    const net = await import('net');
    if (!net.isIP(ip)) {
      return res.status(400).json({ error: 'Invalid IP address format', code: 'VALIDATION_ERROR' });
    }
    if (clientIp && !net.isIP(clientIp)) {
      return res.status(400).json({ error: 'Invalid client IP address format', code: 'VALIDATION_ERROR' });
    }
    const id = uuidv4();

    try {
      await addEtcdMember(name, ip);
    } catch (etcdError) {
      console.warn(`Could not add ETCD member: ${etcdError.message}`);
    }

    await saveNode(id, name, ip, 'offline');
    logEvent('security', 'info', `Node ${name} (${ip}) added`, { nodeId: id, nodeName: name, nodeIp: ip });
    res.status(201).json({ id, name, ip, status: 'offline' });
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'NODE_CREATE_FAILED' });
  }
});

const DNS_SAFE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

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
