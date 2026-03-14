import express from 'express';
import { getSecret, setSecret, deleteSecret, getAllSecretKeys } from '../services/secrets.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const keys = await getAllSecretKeys();
    res.json(keys);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { key, value } = req.body;
    await setSecret(key, value);
    res.status(201).json({ key });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:key', async (req, res) => {
  try {
    await deleteSecret(req.params.key);
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
