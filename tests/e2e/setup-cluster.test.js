import { describe, it, expect } from 'vitest';
import { api, waitForNode, setupNode, NODES } from './helpers.js';

const PASSWORD = process.env.E2E_PASSWORD || 'TestCluster123!';

describe('Cluster setup — create & join', () => {
  // Ensure nodes are healthy
  beforeAll(async () => {
    await Promise.all(Object.keys(NODES).map(k => waitForNode(k, 300000)));
  }, 360000);

  it('creates cluster on node-1', async () => {
    const result = await setupNode('node1', {
      mode: 'create',
      password: PASSWORD,
    });
    expect(result.success).toBe(true);
  });

  it('node-1 is unsealed after setup', async () => {
    const { data } = await api('node1', '/api/system/status');
    expect(data.sealed).toBe(false);
    expect(data.authenticated).toBe(true);
  });

  it('node-1 has a valid session token', async () => {
    // api() auto-captures the token from set-cookie after unseal/setup
    // Trigger a fresh auth request to get a token
    await api('node1', '/api/system/unseal', {
      method: 'POST',
      body: JSON.stringify({ password: PASSWORD }),
    });

    // Now use the token to access an authenticated endpoint
    const { status, data } = await api('node1', '/api/nodes');
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
  });

  it('joins node-2 to the cluster via backhaul', async () => {
    // node-2 uses its own backend to call node-1's join endpoint
    const result = await setupNode('node2', {
      mode: 'join',
      password: PASSWORD,
      primaryIp: NODES.node1.backhaulIp,
    });
    expect(result.success).toBe(true);
  });

  it('node-2 is unsealed after join', async () => {
    // Unseal node-2 after join
    await api('node2', '/api/system/unseal', {
      method: 'POST',
      body: JSON.stringify({ password: PASSWORD }),
    });
    const { data } = await api('node2', '/api/system/status');
    expect(data.sealed).toBe(false);
  });

  it('both nodes visible from node-1', async () => {
    const { data } = await api('node1', '/api/nodes');
    expect(data.length).toBeGreaterThanOrEqual(2);
    const names = data.map(n => n.name);
    expect(names).toContain('node-1');
    expect(names).toContain('node-2');
  });

  it('both nodes are online', async () => {
    const { data } = await api('node1', '/api/nodes');
    for (const node of data) {
      expect(node.status).toBe('online');
    }
  });
});
