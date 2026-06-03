import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const NODE_ID_FILE = '/mnt/backup/__system__/node-id';

let nodeId;

if (process.env.NODE_ID) {
  // Explicitly set via environment — use as-is
  nodeId = process.env.NODE_ID;
} else {
  // Auto-generate and persist across restarts
  try {
    if (fs.existsSync(NODE_ID_FILE)) {
      nodeId = fs.readFileSync(NODE_ID_FILE, 'utf8').trim();
    }
  } catch (e) { /* ignore */ }

  if (!nodeId) {
    nodeId = crypto.randomUUID();
    try {
      const dir = path.dirname(NODE_ID_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(NODE_ID_FILE, nodeId);
    } catch (e) {
      console.warn(`[Config] Could not persist node-id to ${NODE_ID_FILE}: ${e.message}`);
    }
  }
}

export { nodeId };
