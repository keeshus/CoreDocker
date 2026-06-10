import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getGroups, saveGroup, deleteGroup } from '../services/db.js';
import { ensureGroupNetwork, removeGroupNetwork } from '../services/network-manager.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const groups = await getGroups();
    res.json(groups);
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'GROUPS_LIST_FAILED' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, config = { highAvailability: false, internetAccess: false } } = req.body;
    if (!name) return res.status(400).json({ error: 'Group name is required', code: 'VALIDATION_ERROR' });

    const id = uuidv4();
    await saveGroup(id, name, config);
    await ensureGroupNetwork(name, config.internetAccess);
    res.status(201).json({ id, name, config });
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'GROUP_CREATE_FAILED' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { name, config } = req.body;
    await saveGroup(req.params.id, name, config);

    // Recreate group network if internetAccess changed
    if (config && typeof config.internetAccess === 'boolean') {
      await ensureGroupNetwork(name, config.internetAccess);
    }

    res.json({ id: req.params.id, name, config });
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'GROUP_UPDATE_FAILED' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    // Find group name before deleting
    const groups = await getGroups();
    const group = groups.find(g => g.id === req.params.id);
    if (group) {
      await removeGroupNetwork(group.name);
    }
    await deleteGroup(req.params.id);
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'GROUP_DELETE_FAILED' });
  }
});

export default router;
