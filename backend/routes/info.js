import express from 'express';
import docker from '../services/docker.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const info = await docker.info();
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch docker info', details: error.message, code: 'INFO_FAILED' });
  }
});

export default router;
