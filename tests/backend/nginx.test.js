import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../backend/services/docker.js', () => ({ default: {} }));
vi.mock('../../backend/services/db.js', () => ({
  getLocalNodeConfig: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../backend/services/ephemeral-tasks.js', () => ({
  SYSTEM_NAMESPACE: '__system__',
  runEphemeralTask: vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 }),
  writeFileToHost: vi.fn().mockResolvedValue(),
  removeFileFromHost: vi.fn().mockResolvedValue(),
}));
vi.mock('../../backend/services/logger.js', () => ({
  logEvent: vi.fn(),
}));

const { addRoute, removeRoute, reloadNginx } = await import('../../backend/services/nginx.js');

describe('addRoute - validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws on invalid domain format', async () => {
    await expect(addRoute('test', '/api', '3000', 'domain with spaces'))
      .rejects.toThrow('Invalid domain format');
  });

  it('throws on domain with special chars', async () => {
    await expect(addRoute('test', '/api', '3000', 'domain$.com'))
      .rejects.toThrow('Invalid domain format');
  });

  it('accepts valid domain', async () => {
    await expect(addRoute('test', '/api', '3000', 'app.example.com'))
      .resolves.toBeUndefined();
  });

  it('throws on URI with spaces', async () => {
    await expect(addRoute('test', '/api path', '3000'))
      .rejects.toThrow('Invalid URI format');
  });

  it('accepts URI with leading slash (auto-corrected)', async () => {
    await expect(addRoute('test', '/api/v2/', '3000'))
      .resolves.toBeUndefined();
  });

  it('throws on non-numeric port', async () => {
    await expect(addRoute('test', '/api', 'not-a-port'))
      .rejects.toThrow('Invalid port format');
  });

  it('accepts numeric port as string', async () => {
    await expect(addRoute('test', '/api', '8080'))
      .resolves.toBeUndefined();
  });

  it('accepts numeric port as number', async () => {
    await expect(addRoute('test', '/api', 3000))
      .resolves.toBeUndefined();
  });
});

describe('removeRoute', () => {
  it('does not throw for any container name', async () => {
    await expect(removeRoute('my-container')).resolves.toBeUndefined();
  });
});

describe('reloadNginx', () => {
  it('handles no nginx container gracefully', async () => {
    const { default: mockDocker } = await import('../../backend/services/docker.js');
    mockDocker.listContainers = vi.fn().mockResolvedValue([]);
    await expect(reloadNginx()).resolves.toBeUndefined();
  });
});
