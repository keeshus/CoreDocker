import express from 'express';
import { getAllTasks, updateTask, runTask } from '../services/scheduler.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const tasks = await getAllTasks();
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    const { enabled } = req.body;
    
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }

    const task = await updateTask(id, { enabled });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/trigger', async (req, res) => {
  try {
    const { id } = req.params;
    
    runTask(id).catch(console.error); // Run in background
    
    res.json({ success: true, message: 'Task triggered' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
