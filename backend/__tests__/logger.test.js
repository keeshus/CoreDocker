import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEtcd = {
  store: {},
  get: vi.fn(),
};

vi.mock('../services/db.js', () => ({
  default: {
    get: (key) => ({
      string: () => Promise.resolve(mockEtcd.store[key] || null),
    }),
  },
}));

const mockFs = {
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(() => ({ write: vi.fn(), end: vi.fn(), on: vi.fn() })),
  promises: {
    readdir: vi.fn(),
    stat: vi.fn(),
    unlink: vi.fn(),
  },
};

const mockFsp = mockFs.promises;

vi.mock('fs', () => ({
  default: mockFs,
  ...mockFs,
}));
vi.mock('fs/promises', () => ({
  default: mockFsp,
  ...mockFsp,
}));

const { logEvent, startLogger, stopLogger, flushLogs, purgeOldLogs } = await import('../services/logger.js');

beforeEach(() => {
  mockEtcd.store = {};
  vi.clearAllMocks();
  mockFs.mkdirSync.mockReturnValue(undefined);
  mockFs.createWriteStream.mockReturnValue({ write: vi.fn(), end: vi.fn(), on: vi.fn() });
});

describe('logEvent', () => {
  it('does not throw when called with info level', () => {
    expect(() => logEvent('test', 'info', 'test message')).not.toThrow();
  });

  it('does not throw when called with error level', () => {
    expect(() => logEvent('test', 'error', 'error message')).not.toThrow();
  });

  it('does not throw when called with warn level', () => {
    expect(() => logEvent('test', 'warn', 'warning')).not.toThrow();
  });
});

describe('startLogger / stopLogger / flushLogs', () => {
  it('startLogger and stopLogger do not throw', () => {
    expect(() => startLogger()).not.toThrow();
    expect(() => stopLogger()).not.toThrow();
  });

  it('flushLogs does not throw', async () => {
    await expect(flushLogs()).resolves.toBeUndefined();
  });
});

describe('purgeOldLogs', () => {
  it('handles missing log directory gracefully', async () => {
    const { promises: fsp } = await import('fs');
    fsp.readdir.mockRejectedValue(new Error('ENOENT'));

    await expect(purgeOldLogs()).resolves.toBeUndefined();
  });

  it('purges old .ndjson files and keeps recent ones', async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    const { promises: fsp } = await import('fs');
    fsp.readdir.mockResolvedValue(['old.log.ndjson', 'recent.log.ndjson', 'other.txt']);
    fsp.stat.mockImplementation((filePath) => {
      if (String(filePath).includes('old')) {
        return Promise.resolve({ mtimeMs: now - 10 * day });
      }
      return Promise.resolve({ mtimeMs: now - day });
    });
    fsp.unlink.mockResolvedValue();

    await purgeOldLogs();

    expect(fsp.unlink).toHaveBeenCalledTimes(1);
    const deletedFile = fsp.unlink.mock.calls[0][0];
    expect(deletedFile).toContain('old');
  });

  it('respects custom retention from etcd settings', async () => {
    mockEtcd.store['settings/log_retention_days'] = '1';
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    const { promises: fsp } = await import('fs');
    fsp.readdir.mockResolvedValue(['two-days-ago.ndjson']);
    fsp.stat.mockResolvedValue({ mtimeMs: now - 2 * day });
    fsp.unlink.mockResolvedValue();

    await purgeOldLogs();
    expect(fsp.unlink).toHaveBeenCalledTimes(1);
  });

  it('only purges .ndjson and .jsonl files', async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    const { promises: fsp } = await import('fs');
    fsp.readdir.mockResolvedValue(['old.ndjson', 'old.jsonl', 'keep.log', 'keep.txt']);
    fsp.stat.mockResolvedValue({ mtimeMs: now - 10 * day });
    fsp.unlink.mockResolvedValue();

    await purgeOldLogs();
    expect(fsp.unlink).toHaveBeenCalledTimes(2);
  });
});
