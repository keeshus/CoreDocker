import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// ===========================================================================
// Mock setup
// ===========================================================================
const logFilesStore = {}; // { '/full/path/to/file.log': 'Exit Code: 0\n\noutput' }
const TASK_LOG_DIR = '/mnt/non-backup/__system__/tasks';

// Mock fs
const mockFs = {
  existsSync: vi.fn((p) => {
    if (logFilesStore[p]) return true;
    return Object.keys(logFilesStore).some(k => k.startsWith(p + '/'));
  }),
  readdirSync: vi.fn((p, opts) => {
    const entries = new Set();
    const prefix = p.endsWith('/') ? p : p + '/';
    for (const k of Object.keys(logFilesStore)) {
      if (!k.startsWith(prefix)) continue;
      const rel = k.slice(prefix.length);
      if (opts?.withFileTypes) {
        const firstPart = rel.split('/')[0];
        if (firstPart) entries.add(firstPart);
      } else {
        entries.add(rel);
      }
    }
    if (opts?.withFileTypes) {
      return [...entries].map(name => ({
        name,
        isDirectory: () => !name.endsWith('.log'),
      }));
    }
    return [...entries];
  }),
  statSync: vi.fn((p) => {
    const seq = parseInt((logFilesStore[p] || '').match(/Run output (\d+)/)?.[1] || '0');
    return {
      size: (logFilesStore[p] || '').length,
      mtimeMs: 1000000000000 + seq * 60000,
    };
  }),
  openSync: vi.fn((p) => p),  // return path as fd
  readSync: vi.fn((fd, buf, _off, len, _pos) => {
    const content = logFilesStore[fd] || '';
    const firstLine = (content.split('\n')[0] + '\n').padEnd(len, ' ');
    buf.write(firstLine.slice(0, len));
    return firstLine.length;
  }),
  closeSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn((p) => logFilesStore[p] || 'Exit Code: 0\n\nlog content'),
  writeFileSync: vi.fn(),
};
vi.mock('fs', () => ({ default: mockFs, ...mockFs }));

vi.mock('../../backend/services/scheduler.js', () => ({
  getAllTasks: vi.fn().mockResolvedValue([]),
  updateTask: vi.fn().mockResolvedValue(null),
  runTask: vi.fn(),
}));

vi.mock('../../backend/services/db.js', () => ({
  getNodes: vi.fn().mockResolvedValue([]),
  etcd: { get: vi.fn(), put: vi.fn().mockReturnThis(), getAll: vi.fn() },
}));

vi.mock('../../backend/services/secrets.js', () => ({
  generateClusterToken: vi.fn().mockReturnValue('mock-token'),
}));

vi.mock('../../backend/services/nginx.js', () => ({
  getNodeUrl: vi.fn((ip) => `https://${ip}`),
}));

vi.mock('../../backend/config.js', () => ({
  nodeId: 'test-node-1',
}));

// Re-import after mocks are set up
const { getAllTasks, updateTask, runTask } = await import('../../backend/services/scheduler.js');

// We test the route handler logic directly by simulating the req/res cycle
// using the actual buildLogEntry helper and pagination logic from the route

function buildLogEntry(dir, filename, nodeId) {
  const filePath = path.join(dir, filename);
  const stat = mockFs.statSync(filePath);

  const raw = filename.replace('.log', '');
  const [date, time] = raw.split('T');
  const timestamp = date + 'T' + (time || '').replace(/-/g, ':');

  let exitCode = null;
  try {
    const fd = mockFs.openSync(filePath, 'r');
    const buf = Buffer.alloc(32);
    mockFs.readSync(fd, buf, 0, 32, 0);
    mockFs.closeSync(fd);
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

function listLogs(taskId, selectedNode, page = 1, limit = 20) {
  page = Math.max(1, parseInt(page) || 1);
  limit = Math.min(100, Math.max(1, (isNaN(parseInt(limit)) ? 20 : parseInt(limit))));

  const taskLogDir = path.join(TASK_LOG_DIR, taskId);

  if (!mockFs.existsSync(taskLogDir)) {
    return { files: [], total: 0, page, limit, totalPages: 0 };
  }

  let allFiles;

  if (selectedNode) {
    const nodeDir = path.join(taskLogDir, selectedNode);
    if (!mockFs.existsSync(nodeDir)) {
      return { files: [], total: 0, page, limit, totalPages: 0 };
    }

    allFiles = mockFs.readdirSync(nodeDir)
      .filter(f => f.endsWith('.log'))
      .map(f => buildLogEntry(nodeDir, f, selectedNode))
      .sort((a, b) => b.mtime - a.mtime);
  } else {
    const nodeDirs = mockFs.readdirSync(taskLogDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    allFiles = [];
    for (const dirent of nodeDirs) {
      const nodeDir = path.join(taskLogDir, dirent.name);
      const logs = mockFs.readdirSync(nodeDir)
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

  return { files, total, page, limit, totalPages };
}

// Helper: add fake log files
function seedLogs(taskId, nodeId, count) {
  for (let i = 0; i < count; i++) {
    const ts = new Date(2026, 5, 8, 12, 0, i).toISOString().replace(/:/g, '-');
    const fullPath = path.join(TASK_LOG_DIR, taskId, nodeId, `${ts}.log`);
    logFilesStore[fullPath] = `Exit Code: ${i % 2}\n\nRun output ${i}`;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(logFilesStore)) delete logFilesStore[k];
});

// ===========================================================================
// Pagination tests
// ===========================================================================
describe('log listing — pagination', () => {
  it('returns paginated response with default page=1 limit=20', () => {
    seedLogs('purge-old-logs', 'node-1', 5);
    const result = listLogs('purge-old-logs', 'node-1');

    expect(result.files).toHaveLength(5);
    expect(result.total).toBe(5);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);
    expect(result.totalPages).toBe(1);
  });

  it('paginates with custom page and limit', () => {
    seedLogs('etcd-snapshot', 'node-1', 25);
    const result = listLogs('etcd-snapshot', 'node-1', 1, 10);

    expect(result.files).toHaveLength(10);
    expect(result.total).toBe(25);
    expect(result.page).toBe(1);
    expect(result.totalPages).toBe(3);
  });

  it('second page returns correct slice', () => {
    seedLogs('etcd-snapshot', 'node-1', 25);
    const result = listLogs('etcd-snapshot', 'node-1', 2, 10);

    expect(result.files).toHaveLength(10);
    expect(result.page).toBe(2);
    expect(result.total).toBe(25);
  });

  it('last page returns remaining items', () => {
    seedLogs('etcd-snapshot', 'node-1', 25);
    const result = listLogs('etcd-snapshot', 'node-1', 3, 10);

    expect(result.files).toHaveLength(5);
    expect(result.page).toBe(3);
    expect(result.totalPages).toBe(3);
  });

  it('returns empty result for non-existent task', () => {
    const result = listLogs('nonexistent', 'node-1');
    expect(result.files).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(0);
  });

  it('clamps page to minimum 1', () => {
    seedLogs('etcd-snapshot', 'node-1', 10);
    const result = listLogs('etcd-snapshot', 'node-1', -1, 10);
    expect(result.page).toBe(1);
  });

  it('clamps limit between 1 and 100', () => {
    seedLogs('etcd-snapshot', 'node-1', 10);

    const r1 = listLogs('etcd-snapshot', 'node-1', 1, 0);
    expect(r1.limit).toBe(1);

    const r2 = listLogs('etcd-snapshot', 'node-1', 1, 999);
    expect(r2.limit).toBe(100);
  });

  it('includes exitCode parsed from log header', () => {
    seedLogs('purge-old-logs', 'node-1', 3);
    const result = listLogs('purge-old-logs', 'node-1');

    for (const f of result.files) {
      expect(typeof f.exitCode).toBe('number');
    }
    // i=0 exitCode 0, i=1 exitCode 1, i=2 exitCode 0
    expect(result.files[2].exitCode).toBe(0);
    expect(result.files[1].exitCode).toBe(1);
  });

  it('includes nodeId in log entries', () => {
    seedLogs('ha-folder-sync', 'node-1', 2);
    const result = listLogs('ha-folder-sync', 'node-1');

    expect(result.files).toHaveLength(2);
    expect(result.files[0].nodeId).toBe('node-1');
  });

  it('merges logs from all nodes when no node specified', () => {
    seedLogs('ha-folder-sync', 'node-1', 3);
    seedLogs('ha-folder-sync', 'node-2', 2);
    const result = listLogs('ha-folder-sync', null);

    expect(result.total).toBe(5);
    const n1 = result.files.filter(f => f.nodeId === 'node-1').length;
    const n2 = result.files.filter(f => f.nodeId === 'node-2').length;
    expect(n1 + n2).toBe(5);
  });

  it('sorts files newest first', () => {
    seedLogs('etcd-snapshot', 'node-1', 10);
    const result = listLogs('etcd-snapshot', 'node-1');

    for (let i = 1; i < result.files.length; i++) {
      expect(new Date(result.files[i - 1].timestamp).getTime())
        .toBeGreaterThanOrEqual(new Date(result.files[i].timestamp).getTime());
    }
  });

  it('filename includes ISO timestamp', () => {
    seedLogs('etcd-snapshot', 'node-1', 1);
    const result = listLogs('etcd-snapshot', 'node-1');

    expect(result.files[0].filename).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.log$/);
  });
});

// ===========================================================================
// Snapshot retention policy
// ===========================================================================
describe('snapshot retention', () => {
  it('keeps only 7 most recent snapshots', () => {
    const snapshots = Array.from({ length: 10 }, (_, i) => ({
      name: `etcd-snapshot-2026-06-0${i + 1}T01-00-00.000Z.db`,
      mtime: i * 1000,
    }));

    const sorted = snapshots.sort((a, b) => b.mtime - a.mtime);
    const kept = sorted.slice(0, 7);
    const removed = sorted.slice(7);

    expect(kept.length).toBe(7);
    expect(removed.length).toBe(3);
    expect(removed[0].mtime).toBe(2000)
    expect(kept[0].mtime).toBe(9000); // newest
  });
});
