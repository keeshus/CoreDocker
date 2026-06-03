import express from 'express';
import { etcd } from '../services/db.js';

const router = express.Router();
const SETTINGS_KEY = 'cluster/settings';

router.get('/', async (req, res) => {
  try {
    const data = await etcd.get(SETTINGS_KEY).string();
    const settings = data ? JSON.parse(data) : {
      dnsVip: '',
      dnsVipInterface: '',
      dnsForwarder: '',
      sshUser: 'coredocker',
      resticS3Endpoint: '',
      resticS3Bucket: '',
    };
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'SETTINGS_GET_FAILED' });
  }
});

// Allowed settings keys — anything not in this list is rejected on POST.
const ALLOWED_KEYS = [
  'dnsVip',
  'dnsVipInterface',
  'dnsForwarder',
  'clusterDomain',
  'resticS3Endpoint',
  'resticS3Bucket',
  'sshUser',
];

router.post('/', async (req, res) => {
  try {
    // Only persist whitelisted keys — ignore anything else
    const settings = {};
    for (const key of ALLOWED_KEYS) {
      if (key in req.body) {
        settings[key] = req.body[key];
      } else {
        // Preserve existing values for keys not sent in this request
        const existing = await etcd.get(SETTINGS_KEY).string();
        if (existing) {
          const parsed = JSON.parse(existing);
          if (key in parsed) settings[key] = parsed[key];
        }
      }
    }
    await etcd.put(SETTINGS_KEY).value(JSON.stringify(settings));
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'SETTINGS_SAVE_FAILED' });
  }
});

export default router;
