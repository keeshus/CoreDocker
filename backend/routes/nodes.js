import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getNodes, saveNode, deleteNode } from '../services/db.js';
import { addEtcdMember } from '../services/etcd-cluster.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const nodes = await getNodes();
    // Return all nodes, including those from heartbeats. 
    // Filter out potential duplicates or offline nodes based on lastSeen if needed.
    const now = Date.now();
    const activeNodes = nodes.filter(n => (now - (n.lastSeen || 0)) < 30000);
    res.json(activeNodes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, ip, backupPath, nonBackupPath } = req.body;
    const id = uuidv4();
    
    // Attempt to add node to ETCD cluster first
    try {
      await addEtcdMember(name, ip);
    } catch (etcdError) {
      console.warn(`Could not add ETCD member: ${etcdError.message}`);
      // Proceeding with adding node to DB anyway for UI visibility, but status might be degraded
    }

    await saveNode(id, name, ip, 'offline', backupPath, nonBackupPath);
    res.status(201).json({ id, name, ip, status: 'offline', backupPath, nonBackupPath });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await deleteNode(req.params.id);
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
