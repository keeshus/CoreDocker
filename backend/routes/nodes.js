import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getNodes, saveNode, deleteNode } from '../services/db.js';
import { addEtcdMember } from '../services/etcd-cluster.js';

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
    const id = uuidv4();

    try {
      await addEtcdMember(name, ip);
    } catch (etcdError) {
      console.warn(`Could not add ETCD member: ${etcdError.message}`);
    }

    await saveNode(id, name, ip, 'offline');
    res.status(201).json({ id, name, ip, status: 'offline' });
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'NODE_CREATE_FAILED' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await deleteNode(req.params.id);
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'NODE_DELETE_FAILED' });
  }
});

export default router;
