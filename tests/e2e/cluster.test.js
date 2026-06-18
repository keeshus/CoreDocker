import { describe, it, expect, beforeAll } from 'vitest';
import { api, waitForNode, setupNode, ssh, NODES, poll } from './helpers.js';

const PASSWORD = process.env.E2E_PASSWORD || 'TestCluster123!';

describe('CoreDocker Cluster', () => {
  beforeAll(async () => {
    // Reset etcd on all nodes to clear stale state from previous runs
    for (const key of Object.keys(NODES)) {
      try {
        ssh(key, 'sudo docker stop core-docker-etcd 2>/dev/null; sudo docker rm core-docker-etcd 2>/dev/null; sudo rm -rf /opt/coredocker/data/backup/__system__/etcd-data; sudo docker restart core-docker-backend 2>/dev/null');
      } catch {}
    }
    await Promise.all([
      waitForNode('node1', 300000),
      waitForNode('node2', 300000),
      waitForNode('node3', 300000),
    ]);
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

    // Step 9: Join node-2 to cluster via proper setup flow.
    // This calls node-2's /api/system/setup with mode=join, which internally:
    //   - Calls node-1's /api/system/join to add node-2 as an etcd member
    //   - Runs migrateToCluster() to reconfigure node-2's etcd in cluster mode
    //   - Saves auth creds from node-1, reconnects etcd3 client
    //   - Unseals node-2, registers it, and boots cluster services
    const joinResult = await api('node2', '/api/system/setup', {
      method: 'POST',
      body: JSON.stringify({ mode: 'join', primaryIp: '192.168.100.10', joinToken: PASSWORD, password: PASSWORD }),
      timeout: 180000,
    });
    expect(joinResult.status).toBe(200);
    expect(joinResult.data.success).toBe(true);

    // Step 10: Wait for node-2 to become healthy with clustered etcd
    const n2status = await waitForNode('node2', 120000);
    expect(n2status.sealed).toBe(false);

    // Step 11: Verify both nodes are visible in the cluster
    const nodesAfterJoin = await api('node1', '/api/nodes');
    expect(nodesAfterJoin.status).toBe(200);
    expect(nodesAfterJoin.data.length).toBeGreaterThanOrEqual(2);
    expect(nodesAfterJoin.data.find(n => n.name === 'node-2')).toBeTruthy();

    // Step 12: Node-2 can read data from the cluster etcd
    const n2nodes = await api('node2', '/api/nodes');
    expect(n2nodes.status).toBe(200);
    expect(n2nodes.data.length).toBeGreaterThanOrEqual(2);

    // Step 13: Join node-3 to cluster via proper setup flow
    const join3Result = await api('node3', '/api/system/setup', {
      method: 'POST',
      body: JSON.stringify({ mode: 'join', primaryIp: '192.168.100.10', joinToken: PASSWORD, password: PASSWORD }),
      timeout: 180000,
    });
    expect(join3Result.status).toBe(200);
    expect(join3Result.data.success).toBe(true);

    // Step 14: Wait for node-3 to become healthy
    const n3status = await waitForNode('node3', 120000);
    expect(n3status.sealed).toBe(false);

    // Step 15: All three nodes visible from node-1
    const nodesAll = await api('node1', '/api/nodes');
    expect(nodesAll.status).toBe(200);
    expect(nodesAll.data.length).toBeGreaterThanOrEqual(3);
    expect(nodesAll.data.find(n => n.name === 'node-3')).toBeTruthy();

    // Step 16: Node-3 reads from cluster
    const n3nodes = await api('node3', '/api/nodes');
    expect(n3nodes.status).toBe(200);
    expect(n3nodes.data.length).toBeGreaterThanOrEqual(3);
  }, 300000);
});
