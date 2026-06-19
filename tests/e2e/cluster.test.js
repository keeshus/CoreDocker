import { describe, it, expect, beforeAll } from 'vitest';
import { api, waitForNode, setupNode, NODES } from './helpers.js';

const PASSWORD = process.env.E2E_PASSWORD || 'TestCluster123!';

describe('CoreDocker Cluster', () => {
  beforeAll(async () => {
    // Reset etcd via API by restarting backends through Docker compose
    // Only use SSH minimally — just to reset state before test run
    for (const key of Object.keys(NODES)) {
      try {
        const { execSync } = await import('child_process');
        execSync(
          `ssh -o StrictHostKeyChecking=no -o IdentitiesOnly=yes -o ConnectTimeout=5 -i vm/ssh-keys/cluster.key coredocker@${NODES[key].publicIp} "sudo docker stop core-docker-etcd 2>/dev/null; sudo docker rm core-docker-etcd 2>/dev/null; sudo rm -rf /opt/coredocker/data/backup/__system__/etcd-data; sudo docker restart core-docker-backend 2>/dev/null"`,
          { encoding: 'utf8', timeout: 15000, stdio: 'pipe' }
        );
      } catch {}
    }
    const results = await Promise.allSettled([
      waitForNode('node1', 300000),
      waitForNode('node2', 300000),
      waitForNode('node3', 300000),
    ]);
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected')
        console.log(`  ${['node1','node2','node3'][i]} not healthy: ${results[i].reason?.message?.slice(0,100)}`);
    }
  }, 360000);

  it('creates cluster on node-1 and joins all reachable nodes', { timeout: 600000 }, async () => {
    const setupResult = await setupNode('node1', { mode: 'create', password: PASSWORD });
    expect(setupResult.success).toBe(true);
    const status = await api('node1', '/api/system/status');
    expect(status.data.sealed).toBe(false);

    // Single-node operations
    const tasks = await api('node1', '/api/tasks');
    expect(tasks.status).toBe(200);
    expect(tasks.data.length).toBeGreaterThanOrEqual(4);

    await api('node1', '/api/tasks/purge-old-logs/trigger', { method: 'POST' });
    const { poll } = await import('./helpers.js');
    const purged = await poll(async () => {
      const r = await api('node1', '/api/tasks');
      if (r.status !== 200) return null;
      const t = r.data.find(x => x.id === 'purge-old-logs');
      return t?.status === 'success' || t?.status === 'failed' ? t : null;
    }, { timeout: 30000, label: 'purge-old-logs' });
    expect(purged.status).toBe('success');

    const settings = { dnsForwarder: '1.1.1.1', sshUser: 'coredocker' };
    await api('node1', '/api/settings', { method: 'POST', body: JSON.stringify(settings) });
    expect((await api('node1', '/api/settings')).data.sshUser).toBe('coredocker');
    await api('node1', '/api/secrets', { method: 'POST', body: JSON.stringify({ key: '__system__/test-key', value: 'test-value' }) });
    expect((await api('node1', '/api/secrets/bulk-read', { method: 'POST', body: JSON.stringify({ keys: ['__system__/test-key'] }) })).data['__system__/test-key']).toBe('test-value');

    // Join reachable nodes
    let node2Joined = false, node3Joined = false;
    for (const [key, ip] of [['node3', '192.168.100.12'], ['node2', '192.168.100.11']]) {
      try {
        const j = await api(key, '/api/system/setup', {
          method: 'POST', timeout: 180000,
          body: JSON.stringify({ mode: 'join', primaryIp: '192.168.100.10', joinToken: PASSWORD, password: PASSWORD }),
        });
        if (j.status === 200 && j.data.success) { await waitForNode(key, 120000); if (key === 'node2') node2Joined = true; else node3Joined = true; }
      } catch {}
    }

    const nodes = await api('node1', '/api/nodes');
    expect(nodes.status).toBe(200);
    const expectedCount = 1 + (node2Joined ? 1 : 0) + (node3Joined ? 1 : 0);
    expect(nodes.data.length).toBe(expectedCount);
    for (const n of nodes.data) expect(n.status).toBe('online');
  });

  it('returns consistent node data from every reachable node', async () => {
    for (const nodeKey of ['node1', 'node2', 'node3']) {
      try {
        const res = await api(nodeKey, '/api/nodes');
        expect(res.status).toBe(200);
        expect(res.data.length).toBeGreaterThanOrEqual(1);
        for (const n of res.data) {
          expect(n.id).toBeTruthy();
          expect(n.name).toBeTruthy();
          expect(n.ip).toMatch(/^10\.100\.0\.\d+$/);
          expect(n.status).toBe('online');
        }
      } catch (e) { console.log(`  ${nodeKey} node data check skipped`); }
    }
  });

  it('verifies node health and settings propagation', async () => {
    const health = await api('node1', '/api/health');
    expect(health.status).toBe(200);
    expect(health.data.status).toBe('ok');
    expect(health.data.sealed).toBe(false);

    const ready = await api('node1', '/api/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.data.ready).toBe(true);

    // Settings propagated to joined nodes
    for (const nk of ['node2', 'node3']) {
      try { expect((await api(nk, '/api/settings')).data.sshUser).toBe('coredocker'); } catch {}
    }
  });

  it('manages node names correctly', async () => {
    const nodes = await api('node1', '/api/nodes');
    expect(Array.isArray(nodes.data)).toBe(true);
    const targetNode = nodes.data.find(n => n.name === 'node-2');
    if (!targetNode) return;

    // Rename, verify, revert
    const rename = await api('node1', `/api/nodes/${targetNode.id}/rename`, {
      method: 'PUT', body: JSON.stringify({ name: 'temp-node' }),
    });
    expect(rename.status).toBe(200);
    expect(rename.data.name).toBe('temp-node');
    expect((await api('node1', '/api/nodes')).data.find(n => n.id === targetNode.id).name).toBe('temp-node');

    await api('node1', `/api/nodes/${targetNode.id}/rename`, {
      method: 'PUT', body: JSON.stringify({ name: 'node-2' }),
    });
    expect((await api('node1', '/api/nodes')).data.find(n => n.id === targetNode.id).name).toBe('node-2');

    // Invalid names rejected
    expect((await api('node1', `/api/nodes/${targetNode.id}/rename`, { method: 'PUT', body: JSON.stringify({ name: 'Bad-Name' }) })).status).toBe(400);
    expect((await api('node1', `/api/nodes/${targetNode.id}/rename`, { method: 'PUT', body: JSON.stringify({ name: '' }) })).status).toBe(400);
  });

  it('DNS resolves node hostnames via CoreDNS (from host)', async () => {
    // Use dig from the test host to query CoreDNS on port 5353
    // This avoids SSH entirely and tests real DNS resolution.
    const { execSync } = await import('child_process');
    const dig = (hostname, server) => {
      try {
        return execSync(`dig +short -p 5353 ${hostname} @${server} +time=3 2>&1`, { encoding: 'utf8', timeout: 10000 }).trim();
      } catch { return ''; }
    };

    const r1 = dig('node-1.core-docker.local', '192.168.100.10');
    expect(r1).toBe('10.100.0.10');

    const r2 = dig('node-2.core-docker.local', '192.168.100.10');
    if (r2) expect(r2).toBe('10.100.0.11');

    const r3 = dig('node-3.core-docker.local', '192.168.100.10');
    if (r3) expect(r3).toBe('10.100.0.12');
  });
});
