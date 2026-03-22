import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getGroups, saveGroup, deleteGroup } from '../services/db.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const groups = await getGroups();
    res.json(groups);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, config = {} } = req.body;
    if (!name) return res.status(400).json({ error: 'Group name is required' });
    
    const id = uuidv4();
    await saveGroup(id, name, config);
    res.status(201).json({ id, name, config });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { name, config } = req.body;
    await saveGroup(req.params.id, name, config);
    res.json({ id: req.params.id, name, config });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await deleteGroup(req.params.id);
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
