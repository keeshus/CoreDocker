import { describe, it, expect, beforeAll } from 'vitest';
import { api, waitForNode, unsealNode, setupNode, NODES, poll } from './helpers.js';

const PASSWORD = process.env.E2E_PASSWORD || 'TestCluster123!';
const nodeKeys = Object.keys(NODES);

// ═══════════════════════════════════════════════════════════════════════════
// 1. Provisioning — all nodes are alive
// ═══════════════════════════════════════════════════════════════════════════
describe('Cluster provisioning', () => {
  beforeAll(async () => {
    await Promise.all(nodeKeys.map(k => waitForNode(k, 300000)));
  }, 360000);

  it('all 3 nodes respond to status endpoint', async () => {
    for (const key of nodeKeys) {
      const { status } = await api(key, '/api/system/status');
      expect(status).toBe(200);
    }
  });

  it('all 3 nodes are initially sealed', async () => {
    for (const key of nodeKeys) {
      const { data } = await api(key, '/api/system/status');
      expect(data.sealed).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Cluster setup — create on node-1, join node-2
// ═══════════════════════════════════════════════════════════════════════════
describe('Cluster setup', () => {
  it('creates cluster on node-1', async () => {
    const result = await setupNode('node1', { mode: 'create', password: PASSWORD });
    expect(result.success).toBe(true);
  });

  it('node-1 is unsealed after setup', async () => {
    const { data } = await api('node1', '/api/system/status');
    expect(data.sealed).toBe(false);
    expect(data.authenticated).toBe(true);
  });

  it('node-1 can access authenticated endpoints', async () => {
    await unsealNode('node1', PASSWORD);
    const { status, data } = await api('node1', '/api/nodes');
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
  });

  it('joins node-2 to the cluster via backhaul', async () => {
    const result = await setupNode('node2', {
      mode: 'join', joinToken: PASSWORD,
      primaryIp: NODES.node1.backhaulIp,
    });
    expect(result.success).toBe(true);
  });

  it('node-2 is unsealed after join', async () => {
    await unsealNode('node2', PASSWORD);
    const { data } = await api('node2', '/api/system/status');
    expect(data.sealed).toBe(false);
  });

  it('both nodes visible from node-1', async () => {
    const { data } = await api('node1', '/api/nodes');
    expect(data.length).toBeGreaterThanOrEqual(2);
  });

  it('all registered nodes have unique IDs', async () => {
    const { data } = await api('node1', '/api/nodes');
    const ids = new Set(data.map(n => n.id));
    expect(ids.size).toBe(data.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Scheduled tasks
// ═══════════════════════════════════════════════════════════════════════════
describe('Scheduled tasks', () => {
  beforeAll(async () => { await unsealNode('node1', PASSWORD); });

  it('lists all default tasks', async () => {
    const { status, data } = await api('node1', '/api/tasks');
    expect(status).toBe(200);
    expect(data.length).toBeGreaterThanOrEqual(4);
    const ids = data.map(t => t.id);
    expect(ids).toContain('etcd-snapshot');
    expect(ids).toContain('purge-old-logs');
  });

  it('runs etcd-snapshot task', async () => {
    await api('node1', '/api/tasks/etcd-snapshot/trigger', { method: 'POST' });

    const task = await poll(
      async () => {
        const { data } = await api('node1', '/api/tasks');
        const t = data.find(t => t.id === 'etcd-snapshot');
        return t?.status === 'success' ? t : null;
      },
      { timeout: 30000, label: 'etcd-snapshot completion' }
    );
    expect(task.lastOutput).toContain('Snapshot saved');
  });

  it('has log history after running tasks', async () => {
    const { status, data } = await api('node1', '/api/tasks/etcd-snapshot/logs');
    expect(status).toBe(200);
    expect(data.files || data).toBeDefined();
    expect(data.total || data.length).toBeGreaterThanOrEqual(1);
  });

  it('pauses and resumes a task', async () => {
    await api('node1', '/api/tasks/ha-folder-sync/toggle', {
      method: 'POST', body: JSON.stringify({ enabled: false }),
    });
    const { data: afterPause } = await api('node1', '/api/tasks');
    expect(afterPause.find(t => t.id === 'ha-folder-sync').enabled).toBe(false);

    await api('node1', '/api/tasks/ha-folder-sync/toggle', {
      method: 'POST', body: JSON.stringify({ enabled: true }),
    });
    const { data: afterResume } = await api('node1', '/api/tasks');
    expect(afterResume.find(t => t.id === 'ha-folder-sync').enabled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Settings & secrets
// ═══════════════════════════════════════════════════════════════════════════
describe('Settings & secrets', () => {
  beforeAll(async () => { await unsealNode('node1', PASSWORD); });

  it('saves and reads cluster settings', async () => {
    const settings = { dnsForwarder: '1.1.1.1', sshUser: 'coredocker', resticS3Endpoint: 's3.example.com', resticS3Bucket: 'test-bucket' };
    const { status: s } = await api('node1', '/api/settings', { method: 'POST', body: JSON.stringify(settings) });
    expect(s).toBe(200);

    const { data } = await api('node1', '/api/settings');
    expect(data.sshUser).toBe('coredocker');
    expect(data.resticS3Endpoint).toBe('s3.example.com');
  });

  it('saves and bulk-reads encrypted secrets', async () => {
    await api('node1', '/api/secrets', { method: 'POST', body: JSON.stringify({ key: '__system__/cert-domain', value: 'example.com' }) });

    const { data } = await api('node1', '/api/secrets/bulk-read', {
      method: 'POST', body: JSON.stringify({ keys: ['__system__/cert-domain'] }),
    });
    expect(data['__system__/cert-domain']).toBe('example.com');
  });

  it('system secrets hidden from secrets tab', async () => {
    const { data } = await api('node1', '/api/secrets');
    expect(data.filter(k => k.startsWith('__system__/')).length).toBe(0);
  });

  it('cross-node settings consistency', async () => {
    await unsealNode('node2', PASSWORD);
    const { data } = await api('node2', '/api/settings');
    expect(data.resticS3Endpoint).toBe('s3.example.com');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Node management
// ═══════════════════════════════════════════════════════════════════════════
describe('Node management', () => {
  it('node list includes both nodes', async () => {
    const { data } = await api('node1', '/api/nodes');
    expect(data.length).toBeGreaterThanOrEqual(2);
    for (const n of data) {
      expect(n.id).toBeTruthy();
      expect(n.name).toBeTruthy();
      expect(n.status).toBe('online');
    }
  });

  it('renames a node', async () => {
    const { data: nodes } = await api('node1', '/api/nodes');
    const node2 = nodes.find(n => n.name === 'node-2');
    expect(node2).toBeDefined();

    await api('node1', `/api/nodes/${node2.id}/rename`, {
      method: 'PUT', body: JSON.stringify({ name: 'worker-east' }),
    });

    const { data: after } = await api('node1', '/api/nodes');
    expect(after.find(n => n.id === node2.id).name).toBe('worker-east');
  });

  it('rejects invalid DNS names', async () => {
    const { data: nodes } = await api('node1', '/api/nodes');
    const { status, data } = await api('node1', `/api/nodes/${nodes[0].id}/rename`, {
      method: 'PUT', body: JSON.stringify({ name: 'Bad Name' }),
    });
    expect(status).toBe(400);
    expect(data.error).toContain('DNS');
  });
});
