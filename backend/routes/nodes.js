import express from 'express';
import { getNodes, saveNode, deleteNode } from '../services/db.js';
import { logEvent } from '../services/logger.js';

const router = express.Router();
const DNS_SAFE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

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
