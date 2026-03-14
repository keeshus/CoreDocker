import express from 'express';
import etcd from '../services/db.js';

const router = express.Router();
const SETTINGS_KEY = 'cluster/settings';

router.get('/', async (req, res) => {
  try {
    const data = await etcd.get(SETTINGS_KEY).string();
    const settings = data ? JSON.parse(data) : {
      sharedIpPool: '',
      backhaulNetwork: ''
    };
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const settings = req.body;
    await etcd.put(SETTINGS_KEY).value(JSON.stringify(settings));
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
