import express from 'express';
import https from 'https';
import { getAllTasks, updateTask, runTask } from '../services/scheduler.js';
import { getNodes } from '../services/db.js';
import { generateClusterToken } from '../services/secrets.js';
import { getNodeUrl } from '../services/nginx.js';
import { nodeId as localNodeId } from '../config.js';
import fs from 'fs';
import path from 'path';

const router = express.Router();
const TASK_LOG_DIR = '/mnt/non-backup/__system__/tasks';

function insecureFetch(url, opts = {}) {
  const method = opts.method || 'GET';
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(u, {
      method,
      headers: opts.headers || {},
      rejectUnauthorized: false,
      timeout: 60000,
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: async () => JSON.parse(body),
          text: async () => body,
        });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timed out: ${method} ${url}`));
    });
    req.on('error', (err) => reject(err));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// Proxy log requests to remote nodes when the selected node isn't local
async function proxyLogsToNode(req, res, targetNodeId) {
  if (targetNodeId === localNodeId) return false;

  const nodes = await getNodes();
  const node = nodes.find(n => n.id === targetNodeId);
  if (!node) return false;

  const token = generateClusterToken({ node: localNodeId });
  const url = `${getNodeUrl(node.ip)}${req.originalUrl}`;

  const resp = await insecureFetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!resp.ok) {
    return res.status(resp.status).json(await resp.json().catch(() => ({})));
  }
  return res.json(await resp.json());
}

// Parse a log filename into a metadata entry
function buildLogEntry(dir, filename, nodeId) {
  const filePath = path.join(dir, filename);
  const stat = fs.statSync(filePath);

  // Convert filesystem-safe timestamp back: 2026-05-31T07-13-26.472Z → valid ISO
  const raw = filename.replace('.log', '');
  const [date, time] = raw.split('T');
  const timestamp = date + 'T' + (time || '').replace(/-/g, ':');

  // Read first line to extract exit code (format: "Exit Code: N")
  let exitCode = null;
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(32);
    fs.readSync(fd, buf, 0, 32, 0);
    fs.closeSync(fd);
    const firstLine = buf.toString('utf8').split('\n')[0];
    const m = firstLine.match(/Exit Code:\s*(-?\d+)/);
    if (m) exitCode = parseInt(m[1], 10);
  } catch (e) { /* ignore */ }

  return {
    filename,
    nodeId,
    exitCode,
    timestamp: new Date(timestamp).toISOString(),
    size: stat.size,
    mtime: stat.mtimeMs,
  };
}

router.get('/', async (req, res) => {
  try {
    const selectedNode = req.query.node;
    if (selectedNode && selectedNode !== localNodeId) {
      const nodes = await getNodes();
      const node = nodes.find(n => n.id === selectedNode);
      if (node) {
        const token = generateClusterToken({ node: localNodeId });
        const url = `${getNodeUrl(node.ip)}/api/tasks`;
        const resp = await insecureFetch(url, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!resp.ok) return res.status(resp.status).json(await resp.json().catch(() => ({})));
        return res.json(await resp.json());
      }
    }
    const tasks = await getAllTasks();
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'TASKS_LIST_FAILED' });
  }
});

router.post('/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean', code: 'VALIDATION_ERROR' });
    }

    const task = await updateTask(id, { enabled });
    if (!task) return res.status(404).json({ error: 'Task not found', code: 'NOT_FOUND' });

    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'TASK_TOGGLE_FAILED' });
  }
});

router.post('/:id/trigger', async (req, res) => {
  try {
    const { id } = req.params;

    runTask(id, true).catch(console.error);

    res.json({ success: true, message: 'Task triggered' });
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'TASK_TRIGGER_FAILED' });
  }
});

router.get('/:id/logs', async (req, res) => {
  try {
    const { id } = req.params;
    const selectedNode = req.query.node;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));

    // If requesting logs from another node, proxy the request
    if (selectedNode && await proxyLogsToNode(req, res, selectedNode)) return;

    const taskLogDir = path.join(TASK_LOG_DIR, id);

    if (!fs.existsSync(taskLogDir)) {
      return res.json({ files: [], total: 0, page, limit, totalPages: 0 });
    }

    let allFiles;

    // Single node: list only from that node's directory
    if (selectedNode) {
      const nodeDir = path.join(taskLogDir, selectedNode);
      if (!fs.existsSync(nodeDir)) {
        return res.json({ files: [], total: 0, page, limit, totalPages: 0 });
      }

      allFiles = fs.readdirSync(nodeDir)
        .filter(f => f.endsWith('.log'))
        .map(f => buildLogEntry(nodeDir, f, selectedNode))
        .sort((a, b) => b.mtime - a.mtime);
    } else {
      // All nodes: merge logs from every node subdirectory
      const nodeDirs = fs.readdirSync(taskLogDir, { withFileTypes: true })
        .filter(d => d.isDirectory());

      allFiles = [];
      for (const dirent of nodeDirs) {
        const nodeDir = path.join(taskLogDir, dirent.name);
        const logs = fs.readdirSync(nodeDir)
          .filter(f => f.endsWith('.log'))
          .map(f => buildLogEntry(nodeDir, f, dirent.name));
        allFiles.push(...logs);
      }
      allFiles.sort((a, b) => b.mtime - a.mtime);
    }

    const total = allFiles.length;
    const totalPages = Math.ceil(total / limit);
    const start = (page - 1) * limit;
    const files = allFiles.slice(start, start + limit);

    res.json({ files, total, page, limit, totalPages });
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'TASK_LOGS_LIST_FAILED' });
  }
});

router.get('/:id/logs/:filename', async (req, res) => {
  try {
    const { id, filename } = req.params;
    const nodeId = req.query.node || '';

    // If requesting log content from another node, proxy the request
    if (nodeId && await proxyLogsToNode(req, res, nodeId)) return;

    // Prevent path traversal — validate all three path components
    if (filename.includes('..') || filename.includes('/')) {
      return res.status(400).json({ error: 'Invalid filename', code: 'VALIDATION_ERROR' });
    }
    if (nodeId.includes('..') || nodeId.includes('/')) {
      return res.status(400).json({ error: 'Invalid node', code: 'VALIDATION_ERROR' });
    }
    if (id.includes('..') || id.includes('/')) {
      return res.status(400).json({ error: 'Invalid task id', code: 'VALIDATION_ERROR' });
    }

    let filePath;
    if (nodeId) {
      filePath = path.join(TASK_LOG_DIR, id, nodeId, filename);
    } else {
      // Without a node ID, search all node dirs for the filename
      const taskDir = path.join(TASK_LOG_DIR, id);
      if (!fs.existsSync(taskDir)) {
        return res.status(404).json({ error: 'Log file not found', code: 'NOT_FOUND' });
      }
      const nodeDirs = fs.readdirSync(taskDir, { withFileTypes: true })
        .filter(d => d.isDirectory());
      for (const dirent of nodeDirs) {
        const candidate = path.join(taskDir, dirent.name, filename);
        if (fs.existsSync(candidate)) {
          filePath = candidate;
          break;
        }
      }
      if (!filePath) {
        return res.status(404).json({ error: 'Log file not found', code: 'NOT_FOUND' });
      }
    }

    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'TASK_LOG_GET_FAILED' });
  }
});

export default router;
