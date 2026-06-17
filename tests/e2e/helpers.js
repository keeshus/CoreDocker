import https from 'https';
import { execSync } from 'child_process';

// ── Node definitions ──────────────────────────────────────────────────────
export const NODES = {
  node1: { publicIp: '192.168.100.10', backhaulIp: '10.100.0.10', name: 'node-1' },
  node2: { publicIp: '192.168.100.11', backhaulIp: '10.100.0.11', name: 'node-2' },
  node3: { publicIp: '192.168.100.12', backhaulIp: '10.100.0.12', name: 'node-3' },
};

// ── Attach a node's auth token to subsequent calls ─────────────────────────
const authTokens = {};

export function setAuthToken(nodeKey, token) {
  authTokens[nodeKey] = token;
}

// ── HTTP helpers ───────────────────────────────────────────────────────────
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed certs on VMs

/**
 * Call a CoreDocker API on a specific node.
 * @param {string} nodeKey - 'node1', 'node2', or 'node3'
 * @param {string} path - e.g. '/api/system/status'
 * @param {object} options - fetch options (method, body, headers)
 * @returns {Promise<{status: number, data: any}>}
 */
export async function api(nodeKey, path, options = {}) {
  const node = NODES[nodeKey];
  if (!node) throw new Error(`Unknown node: ${nodeKey}`);
  const url = `https://${node.publicIp}${path}`;

  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (authTokens[nodeKey]) {
    headers['Cookie'] = `token=${authTokens[nodeKey]}`;
  }

  // Node's global fetch() doesn't support https.Agent — use node:https directly
  const { method = 'GET', body } = options;
  const result = await new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, rejectUnauthorized: false }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }

        // Capture token from set-cookie (Node lowercases headers)
        const setCookie = res.headers['set-cookie'] || res.headers['Set-Cookie'];
        if (setCookie) {
          const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
          const match = cookieStr.match(/token=([^;]+)/);
          if (match) {
            setAuthToken(nodeKey, match[1]);
            console.log(`  [auth] token captured for ${nodeKey}`);
          }
        }

        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });

  return result;
}

// ── Higher-level helpers ───────────────────────────────────────────────────

/**
 * Wait for a node's API to become healthy (retries until timeout).
 */
export async function waitForNode(nodeKey, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { status, data } = await api(nodeKey, '/api/health/ready');
      if (status === 200 && data?.ready) {
        const s = await api(nodeKey, '/api/system/status');
        const name = s.data?.nodeName || s.data?.nodeId || 'unknown';
        console.log(`  ${nodeKey} ready (${name})`);
        return s.data;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error(`${nodeKey} did not become healthy within ${timeoutMs / 1000}s`);
}

/**
 * SSH into a VM and run a command.
 */
export function ssh(nodeKey, command) {
  const node = NODES[nodeKey];
  const keyPath = 'vm/ssh-keys/cluster.key';
  return execSync(
    `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -i ${keyPath} coredocker@${node.publicIp} "${command}"`,
    { encoding: 'utf8', timeout: 15000 }
  ).trim();
}

/**
 * Poll until a condition is met.
 */
export async function poll(fn, { timeout = 30000, interval = 2000, label = '' } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (e) {
      lastError = e;
    }
    await new Promise(r => setTimeout(r, interval));
  }
  throw lastError || new Error(`Poll timeout after ${timeout}ms${label ? ': ' + label : ''}`);
}

/**
 * Unseal a node with the master password.
 */
export async function unsealNode(nodeKey, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { status, data } = await api(nodeKey, '/api/system/unseal', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      if (status === 200) return data;
      if (attempt === 0) {
        console.log(`  Unseal failed on ${nodeKey} (attempt 1): ${JSON.stringify(data).slice(0,100)}`);
        await new Promise(r => setTimeout(r, 5000));
      } else {
        throw new Error(`Unseal failed on ${nodeKey}: ${JSON.stringify(data).slice(0,200)}`);
      }
    } catch (e) {
      if (attempt === 0) {
        console.log(`  Unseal failed on ${nodeKey} (attempt 1): ${e.message}`);
        await new Promise(r => setTimeout(r, 5000));
      } else {
        throw e;
      }
    }
  }
}

/**
 * Setup a node (create cluster, join, or restore).
 */
export async function setupNode(nodeKey, payload) {
  // Retry setup once — fresh VMs can be slow after Docker build
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { status, data } = await api(nodeKey, '/api/system/setup', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (status === 200) return data;
      if (attempt === 0) {
        console.log(`  Setup failed on ${nodeKey} (attempt 1): ${JSON.stringify(data).slice(0,100)}`);
        await new Promise(r => setTimeout(r, 10000));
      } else {
        throw new Error(`Setup failed on ${nodeKey}: ${JSON.stringify(data).slice(0,200)}`);
      }
    } catch (e) {
      if (attempt === 0) {
        console.log(`  Setup failed on ${nodeKey} (attempt 1): ${e.message}`);
        await new Promise(r => setTimeout(r, 10000));
      } else {
        throw e;
      }
    }
  }
}
