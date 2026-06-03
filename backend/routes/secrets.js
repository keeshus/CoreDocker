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

router.post('/bulk-read', async (req, res) => {
  try {
    const { keys } = req.body;
    if (!Array.isArray(keys)) {
      return res.status(400).json({ error: 'keys must be an array', code: 'VALIDATION_ERROR' });
    }
    const result = {};
    for (const key of keys) {
      result[key] = await getSecret(key);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'SECRETS_BULK_READ_FAILED' });
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

router.put('/:key', async (req, res) => {
  try {
    const { value } = req.body;
    if (!value) {
      return res.status(400).json({ error: 'Value is required', code: 'VALIDATION_ERROR' });
    }
    await setSecret(req.params.key, value);
    res.json({ key: req.params.key });
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'SECRET_UPDATE_FAILED' });
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
