import { describe, it, expect, vi, beforeEach } from 'vitest';

const etcdStore = {};

const mockDbDefault = {
  get: vi.fn((key) => ({
    string: () => Promise.resolve(etcdStore[key] || null),
  })),
  put: vi.fn((key) => ({
    value: (val) => {
      etcdStore[key] = val;
      return Promise.resolve();
    },
  })),
  getAll: vi.fn((prefix) => ({
    prefix: () => ({
      strings: () => {
        const results = {};
        for (const [k, v] of Object.entries(etcdStore)) {
          if (k.startsWith(prefix)) results[k] = v;
        }
        return Promise.resolve(results);
      },
    }),
  })),
  delete: vi.fn((key) => ({
    key: () => {
      delete etcdStore[key];
      return Promise.resolve();
    },
  })),
  lease: vi.fn(() => ({
    put: vi.fn().mockReturnThis(),
    value: vi.fn().mockReturnThis(),
    ifAbsent: vi.fn().mockResolvedValue(true),
    revoke: vi.fn().mockResolvedValue(),
    on: vi.fn().mockReturnThis(),
  })),
  election: vi.fn(() => ({
    campaign: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
    })),
  })),
};

vi.mock('../services/db.js', () => ({
  default: mockDbDefault,
  getContainers: vi.fn().mockResolvedValue([]),
  getNodes: vi.fn().mockResolvedValue([]),
  saveContainer: vi.fn().mockResolvedValue(),
}));

vi.mock('../services/logger.js', () => ({
  logEvent: vi.fn(),
  purgeOldLogs: vi.fn(),
}));

vi.mock('../services/ephemeral-tasks.js', () => ({
  runEphemeralTask: vi.fn().mockResolvedValue({ stdout: 'done', exitCode: 0 }),
}));

const {
  startScheduler, stopScheduler, getTask, getAllTasks,
  updateTask, runTask,
} = await import('../services/scheduler.js');

beforeEach(() => {
  for (const key of Object.keys(etcdStore)) {
    delete etcdStore[key];
  }
  vi.clearAllMocks();
});

describe('DEFAULT_TASKS', () => {
  it('has 5 predefined tasks', async () => {
    const tasks = await getAllTasks();
    expect(tasks.length).toBe(5);
  });

  it('each task has required fields', async () => {
    const tasks = await getAllTasks();
    for (const task of tasks) {
      expect(task).toHaveProperty('id');
      expect(task).toHaveProperty('name');
      expect(task).toHaveProperty('scheduleDesc');
      expect(task).toHaveProperty('intervalMs');
      expect(task).toHaveProperty('enabled');
      expect(task).toHaveProperty('scope');
      expect(task).toHaveProperty('status');
      expect(task).toHaveProperty('lastRun');
      expect(task).toHaveProperty('nextRun');
    }
  });

  it('purge-old-logs and ha-folder-sync are enabled by default', async () => {
    const tasks = await getAllTasks();
    expect(tasks.find(t => t.id === 'purge-old-logs').enabled).toBe(true);
    expect(tasks.find(t => t.id === 'ha-folder-sync').enabled).toBe(true);
  });

  it('restic-backup and certbot-renew are disabled by default', async () => {
    const tasks = await getAllTasks();
    expect(tasks.find(t => t.id === 'restic-backup').enabled).toBe(false);
    expect(tasks.find(t => t.id === 'certbot-renew').enabled).toBe(false);
  });

  it('has correct scopes', async () => {
    const tasks = await getAllTasks();
    expect(tasks.find(t => t.id === 'purge-old-logs').scope).toBe('cluster');
    expect(tasks.find(t => t.id === 'ha-folder-sync').scope).toBe('node');
    expect(tasks.find(t => t.id === 'etcd-snapshot').scope).toBe('node');
  });
});

describe('getTask', () => {
  it('returns existing task from etcd', async () => {
    etcdStore['tasks/test-task'] = JSON.stringify({
      id: 'test-task', name: 'Test', intervalMs: 60000, enabled: true,
      status: 'success', lastRun: null, nextRun: '2025-01-01T00:00:00.000Z',
    });

    const task = await getTask('test-task');
    expect(task.id).toBe('test-task');
    expect(task.status).toBe('success');
  });

  it('creates new task from defaults when not in etcd', async () => {
    const task = await getTask('etcd-snapshot');
    expect(task).not.toBeNull();
    expect(task.id).toBe('etcd-snapshot');
    expect(task.status).toBe('idle');
    expect(etcdStore['tasks/etcd-snapshot']).toBeDefined();
    expect(task.nextRun).toBeDefined();
  });

  it('returns null for unknown task ID', async () => {
    const task = await getTask('nonexistent-task');
    expect(task).toBeNull();
  });
});

describe('updateTask', () => {
  it('updates fields on existing task', async () => {
    await getTask('etcd-snapshot');
    const updated = await updateTask('etcd-snapshot', { enabled: false, status: 'running' });
    expect(updated.enabled).toBe(false);
    expect(updated.status).toBe('running');

    const stored = JSON.parse(etcdStore['tasks/etcd-snapshot']);
    expect(stored.enabled).toBe(false);
    expect(stored.status).toBe('running');
  });

  it('returns null for non-existent task', async () => {
    const result = await updateTask('unknown', { enabled: true });
    expect(result).toBeNull();
  });
});

describe('runTask guard clauses', () => {
  it('returns early when task is disabled', async () => {
    const task = await getTask('restic-backup');
    expect(task.enabled).toBe(false);
    await runTask('restic-backup');
  });

  it('returns early when nextRun is in the future', async () => {
    etcdStore['tasks/future-task'] = JSON.stringify({
      id: 'future-task', name: 'Future', intervalMs: 60000, enabled: true, scope: 'node',
      status: 'idle', lastRun: null, nextRun: '2099-12-31T23:59:59.000Z',
    });

    await runTask('future-task');
    const stored = JSON.parse(etcdStore['tasks/future-task']);
    expect(stored.status).toBe('idle');
  });
});

describe('startScheduler / stopScheduler', () => {
  it('startScheduler and stopScheduler do not throw', () => {
    stopScheduler();
    startScheduler();
    stopScheduler();
  });
});
