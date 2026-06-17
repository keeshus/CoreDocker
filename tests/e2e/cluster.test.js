import { describe, it, expect, beforeAll } from 'vitest';
import { api, waitForNode, setupNode, NODES, poll } from './helpers.js';

const PASSWORD = process.env.E2E_PASSWORD || 'TestCluster123!';

describe('CoreDocker Cluster', () => {
  beforeAll(async () => {
    await waitForNode('node1', 300000);
  }, 360000);

  it('creates cluster on node-1 and runs all single-node operations', async () => {
    // Step 1: Create cluster on node-1
    const setupResult = await setupNode('node1', { mode: 'create', password: PASSWORD });
    expect(setupResult.success).toBe(true);

    // Step 2: Verify unsealed
    const status = await api('node1', '/api/system/status');
    expect(status.data.sealed).toBe(false);

    // Step 3: List tasks
    const tasks = await api('node1', '/api/tasks');
    expect(tasks.status).toBe(200);
    expect(tasks.data.length).toBeGreaterThanOrEqual(4);

    // Step 4: Trigger purge-old-logs
    await api('node1', '/api/tasks/purge-old-logs/trigger', { method: 'POST' });
    const purged = await poll(
      async () => {
        const r = await api('node1', '/api/tasks');
        if (r.status !== 200) return null;
        const t = r.data.find(t => t.id === 'purge-old-logs');
        return t?.status === 'success' || t?.status === 'failed' ? t : null;
      },
      { timeout: 30000, label: 'purge-old-logs' }
    );
    expect(purged.status).toBe('success');

    // Step 5: Save and read settings
    const settings = { dnsForwarder: '1.1.1.1', sshUser: 'coredocker' };
    const save = await api('node1', '/api/settings', { method: 'POST', body: JSON.stringify(settings) });
    expect(save.status).toBe(200);
    const read = await api('node1', '/api/settings');
    expect(read.data.sshUser).toBe('coredocker');

    // Step 6: Save and read encrypted secret
    await api('node1', '/api/secrets', {
      method: 'POST',
      body: JSON.stringify({ key: '__system__/test-key', value: 'test-value' }),
    });
    const bulk = await api('node1', '/api/secrets/bulk-read', {
      method: 'POST',
      body: JSON.stringify({ keys: ['__system__/test-key'] }),
    });
    expect(bulk.data['__system__/test-key']).toBe('test-value');

    // Step 7: System secrets hidden from tab
    const secrets = await api('node1', '/api/secrets');
    expect(secrets.data.filter(k => k.startsWith('__system__/')).length).toBe(0);

    // Step 8: Node management
    const nodes = await api('node1', '/api/nodes');
    expect(nodes.status).toBe(200);
    expect(nodes.data.length).toBeGreaterThanOrEqual(1);
    const n1 = nodes.data[0];
    expect(n1.id).toBeTruthy();
    expect(n1.status).toBe('online');
    await api('node1', `/api/nodes/${n1.id}/rename`, {
      method: 'PUT', body: JSON.stringify({ name: 'test-node' }),
    });
    const afterRename = await api('node1', '/api/nodes');
    expect(afterRename.data.find(n => n.id === n1.id).name).toBe('test-node');
    await api('node1', `/api/nodes/${n1.id}/rename`, {
      method: 'PUT', body: JSON.stringify({ name: 'node-1' }),
    });
    const bad = await api('node1', `/api/nodes/${n1.id}/rename`, {
      method: 'PUT', body: JSON.stringify({ name: 'Bad Name' }),
    });
    expect(bad.status).toBe(400);

    // Step 9: Join node-2 (final step — after this, etcd has 2 members and needs quorum)
    const joinResult = await api('node1', '/api/system/join', {
      method: 'POST',
      body: JSON.stringify({ name: 'node-2', ip: '10.100.0.11', clientIp: '192.168.100.11' }),
      headers: { 'Authorization': `Bearer ${PASSWORD}` },
    });
    expect(joinResult.status).toBe(200);
    expect(joinResult.data.success).toBe(true);
  }, 300000);
});
