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
const agent = new https.Agent({ rejectUnauthorized: false });

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

  const res = await fetch(url, {
    ...options,
    headers,
    agent,
    redirect: 'manual',
  });

  let data;
  try {
    data = await res.json();
  } catch {
    data = await res.text();
  }

  // Capture token from set-cookie
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const match = setCookie.match(/token=([^;]+)/);
    if (match) setAuthToken(nodeKey, match[1]);
  }

  return { status: res.status, data };
}

// ── Higher-level helpers ───────────────────────────────────────────────────

/**
 * Wait for a node's API to become healthy (retries until timeout).
 */
export async function waitForNode(nodeKey, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { status, data } = await api(nodeKey, '/api/system/status');
      if (status === 200 && data && !data.error) {
        console.log(`  ${nodeKey} ready (${data.nodeName || 'unknown'})`);
        return data;
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
  const { status, data } = await api(nodeKey, '/api/system/unseal', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  if (status !== 200) throw new Error(`Unseal failed on ${nodeKey}: ${JSON.stringify(data)}`);
  return data;
}

/**
 * Setup a node (create cluster, join, or restore).
 */
export async function setupNode(nodeKey, payload) {
  const formData = new FormData();
  for (const [k, v] of Object.entries(payload)) {
    formData.append(k, v);
  }
  const { status, data } = await api(nodeKey, '/api/system/setup', {
    method: 'POST',
    body: formData,
    headers: {}, // let fetch set multipart boundary
  });
  if (status !== 200) throw new Error(`Setup failed on ${nodeKey}: ${JSON.stringify(data)}`);
  return data;
}
