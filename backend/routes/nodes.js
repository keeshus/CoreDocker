import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getNodes, saveNode, deleteNode } from '../services/db.js';
import { addEtcdMember } from '../services/etcd-cluster.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const nodes = await getNodes();
    // Return all nodes. We trust the frontend to show status based on lastSeen.
    // If a node was manually registered it should always show up.
    // Heartbeat-only nodes will eventually be cleaned up by ETCD lease.
    res.json(nodes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id/settings', async (req, res) => {
  try {
    const nodes = await getNodes();
    const node = nodes.find(n => n.id === req.params.id);
    if (!node) return res.status(404).json({ error: 'Node not found' });
    
    res.json({
      backupPath: node.backupPath || '/data/backup',
      nonBackupPath: node.nonBackupPath || '/data/non-backup'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/settings', async (req, res) => {
  try {
    const { backupPath, nonBackupPath } = req.body;
    const nodes = await getNodes();
    const node = nodes.find(n => n.id === req.params.id);
    if (!node) return res.status(404).json({ error: 'Node not found' });

    node.backupPath = backupPath;
    node.nonBackupPath = nonBackupPath;
    
    await saveNode(node.id, node.name, node.ip, node.status, node.backupPath, node.nonBackupPath);
    res.json(node);
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
