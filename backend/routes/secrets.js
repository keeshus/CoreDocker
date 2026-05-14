import express from 'express';
import { getSecret, setSecret, deleteSecret, getAllSecretKeys } from '../services/secrets.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const keys = await getAllSecretKeys();
    res.json(keys);
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'SECRETS_LIST_FAILED' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key || !value) {
      return res.status(400).json({ error: 'Key and value are required', code: 'VALIDATION_ERROR' });
    }
    await setSecret(key, value);
    res.status(201).json({ key });
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'SECRET_CREATE_FAILED' });
  }
});

router.delete('/:key', async (req, res) => {
  try {
    await deleteSecret(req.params.key);
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'SECRET_DELETE_FAILED' });
  }
});

export default router;
