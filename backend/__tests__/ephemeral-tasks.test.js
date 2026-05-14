import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDocker = {};
vi.mock('../services/docker.js', () => ({ default: mockDocker }));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(),
  writeFile: vi.fn().mockResolvedValue(),
  unlink: vi.fn().mockResolvedValue(),
}));

vi.mock('fs', () => ({}));

const {
  validatePath, demuxDockerLogs, writeFileToHost, removeFileFromHost,
} = await import('../services/ephemeral-tasks.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('validatePath', () => {
  it('throws on path traversal with ..', () => {
    expect(() => validatePath('safe/../etc/passwd')).toThrow('Path traversal detected');
  });

  it('throws on invalid characters', () => {
    expect(() => validatePath('path with spaces')).toThrow('Invalid characters in path');
  });

  it('throws on shell special characters', () => {
    expect(() => validatePath('path;rm -rf /')).toThrow('Invalid characters in path');
  });

  it('accepts valid paths', () => {
    expect(() => validatePath('nginx/conf.d/default.conf')).not.toThrow();
  });

  it('accepts paths with dots and dashes', () => {
    expect(() => validatePath('nginx/ssl/my-container.crt')).not.toThrow();
  });

  it('throws on paths with < >', () => {
    expect(() => validatePath('<script>')).toThrow('Invalid characters in path');
  });
});

describe('demuxDockerLogs', () => {
  it('separates stdout and stderr from Docker multiplexed stream', () => {
    const stdoutFrame = Buffer.alloc(8);
    stdoutFrame[0] = 1;
    stdoutFrame.writeUInt32BE(5, 4);
    const stdoutData = Buffer.from('hello');
    const stderrFrame = Buffer.alloc(8);
    stderrFrame[0] = 2;
    stderrFrame.writeUInt32BE(5, 4);
    const stderrData = Buffer.from('error');
    const buffer = Buffer.concat([stdoutFrame, stdoutData, stderrFrame, stderrData]);

    const result = demuxDockerLogs(buffer);
    expect(result.stdout).toBe('hello');
    expect(result.stderr).toBe('error');
  });

  it('handles partial frames gracefully', () => {
    const buffer = Buffer.from([1, 0, 0, 0, 0, 0, 0, 10, 104, 105]);
    const result = demuxDockerLogs(buffer);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('returns empty strings for empty buffer', () => {
    const result = demuxDockerLogs(Buffer.alloc(0));
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('handles buffer shorter than 8-byte header', () => {
    const result = demuxDockerLogs(Buffer.from([1, 2, 3]));
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('demuxes multiple frames correctly', () => {
    const frames = [];
    const texts = [
      { stream: 1, data: 'line1\n' },
      { stream: 2, data: 'err1\n' },
      { stream: 1, data: 'line2\n' },
    ];
    for (const t of texts) {
      const header = Buffer.alloc(8);
      header[0] = t.stream;
      header.writeUInt32BE(t.data.length, 4);
      frames.push(header, Buffer.from(t.data));
    }
    const buffer = Buffer.concat(frames);

    const result = demuxDockerLogs(buffer);
    expect(result.stdout).toBe('line1\nline2\n');
    expect(result.stderr).toBe('err1\n');
  });
});

describe('writeFileToHost / removeFileFromHost (path validation only)', () => {
  it('writeFileToHost throws on path traversal', async () => {
    await expect(writeFileToHost('../etc/shadow', 'data'))
      .rejects.toThrow('Path traversal detected');
  });

  it('removeFileFromHost throws on path traversal', async () => {
    await expect(removeFileFromHost('../etc/shadow'))
      .rejects.toThrow('Path traversal detected');
  });

  it('writeFileToHost throws on invalid characters', async () => {
    await expect(writeFileToHost('nginx/conf.d/<inject>.conf', 'data'))
      .rejects.toThrow('Invalid characters in path');
  });
});
