import { describe, it, expect } from 'vitest';
import { api, waitForNode, unsealNode, NODES, poll } from './helpers.js';

const PASSWORD = process.env.E2E_PASSWORD || 'TestCluster123!';

describe('Scheduled tasks', () => {
  beforeAll(async () => {
    await waitForNode('node1', 300000);
    await unsealNode('node1', PASSWORD);
  }, 360000);

  it('lists all default tasks', async () => {
    const { status, data } = await api('node1', '/api/tasks');
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(4);

    const ids = data.map(t => t.id);
    expect(ids).toContain('etcd-snapshot');
    expect(ids).toContain('purge-old-logs');
    expect(ids).toContain('ha-folder-sync');
    expect(ids).toContain('restic-backup');
  });

  it('runs etcd-snapshot task via trigger', async () => {
    const { status: triggerStatus } = await api('node1', '/api/tasks/etcd-snapshot/trigger', {
      method: 'POST',
    });
    expect(triggerStatus).toBe(200);

    // Wait for task to complete (snapshot should be fast)
    const task = await poll(
      async () => {
        const { data } = await api('node1', '/api/tasks');
        const t = data.find(t => t.id === 'etcd-snapshot');
        if (t?.status === 'success' || t?.status === 'failed') return t;
        return null;
      },
      { timeout: 30000, interval: 2000, label: 'etcd-snapshot completion' }
    );

    expect(task.status).toBe('success');
    expect(task.lastOutput).toContain('Snapshot saved');
  });

  it('runs purge-old-logs task via trigger', async () => {
    const { status: triggerStatus } = await api('node1', '/api/tasks/purge-old-logs/trigger', {
      method: 'POST',
    });
    expect(triggerStatus).toBe(200);

    const task = await poll(
      async () => {
        const { data } = await api('node1', '/api/tasks');
        const t = data.find(t => t.id === 'purge-old-logs');
        if (t?.status === 'success' || t?.status === 'failed') return t;
        return null;
      },
      { timeout: 15000, interval: 2000, label: 'purge-old-logs completion' }
    );

    expect(task.status).toBe('success');
  });

  it('has log history after running tasks', async () => {
    const { status, data } = await api('node1', '/api/tasks/etcd-snapshot/logs');
    expect(status).toBe(200);
    expect(data.files).toBeDefined();
    expect(data.total).toBeGreaterThanOrEqual(1);
  });

  it('pauses and resumes a task', async () => {
    // Pause
    const { status: pauseStatus } = await api('node1', '/api/tasks/ha-folder-sync/toggle', {
      method: 'POST',
      body: JSON.stringify({ enabled: false }),
    });
    expect(pauseStatus).toBe(200);

    // Verify paused
    const { data: afterPause } = await api('node1', '/api/tasks');
    const paused = afterPause.find(t => t.id === 'ha-folder-sync');
    expect(paused.enabled).toBe(false);

    // Resume
    await api('node1', '/api/tasks/ha-folder-sync/toggle', {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    });

    const { data: afterResume } = await api('node1', '/api/tasks');
    const resumed = afterResume.find(t => t.id === 'ha-folder-sync');
    expect(resumed.enabled).toBe(true);
  });
});
