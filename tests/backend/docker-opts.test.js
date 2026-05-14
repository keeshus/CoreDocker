import { describe, it, expect, vi } from 'vitest';

const mockGetSecret = vi.fn();
const mockGetLocalNodeConfig = vi.fn();

vi.mock('../../backend/services/db.js', () => ({
  getLocalNodeConfig: () => mockGetLocalNodeConfig(),
}));

vi.mock('../../backend/services/secrets.js', () => ({
  getSecret: (key) => mockGetSecret(key),
}));

const { buildCreateOpts } = await import('../../backend/utils/docker-opts.js');

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLocalNodeConfig.mockResolvedValue({});
  mockGetSecret.mockResolvedValue(null);
});

describe('buildCreateOpts - image validation', () => {
  it('throws for invalid image name with special chars', async () => {
    await expect(buildCreateOpts('test', 'invalid image!', [], [], [], 'always', {}))
      .rejects.toThrow('Invalid image name');
  });

  it('accepts valid image names', async () => {
    const result = await buildCreateOpts('web', 'nginx:latest', [], [], [], 'always', {});
    expect(result.Image).toBe('nginx:latest');
  });

  it('accepts registry image names with path', async () => {
    const result = await buildCreateOpts('app', 'myregistry.io/myteam/app:v1.2.3', [], [], [], 'always', {});
    expect(result.Image).toBe('myregistry.io/myteam/app:v1.2.3');
  });
});

describe('buildCreateOpts - restart policy validation', () => {
  it('throws for invalid restart policy', async () => {
    await expect(buildCreateOpts('test', 'nginx', [], [], [], 'invalid-policy', {}))
      .rejects.toThrow('Invalid restart policy');
  });

  it('accepts all valid restart policies', async () => {
    const policies = ['no', 'always', 'unless-stopped', 'on-failure'];
    for (const policy of policies) {
      const result = await buildCreateOpts('test', 'nginx', [], [], [], policy, {});
      expect(result.HostConfig.RestartPolicy.Name).toBe(policy);
    }
  });
});

describe('buildCreateOpts - port bindings', () => {
  it('builds port bindings correctly', async () => {
    const ports = [
      { ip: '0.0.0.0', host: '8080', container: '80' },
      { host: '443', container: '443' },
    ];
    const result = await buildCreateOpts('web', 'nginx', [], [], ports, 'always', {});

    expect(result.ExposedPorts['80/tcp']).toEqual({});
    expect(result.ExposedPorts['443/tcp']).toEqual({});
    expect(result.HostConfig.PortBindings['80/tcp']).toEqual([
      { HostIp: '0.0.0.0', HostPort: '8080' },
    ]);
    expect(result.HostConfig.PortBindings['443/tcp']).toEqual([
      { HostIp: '', HostPort: '443' },
    ]);
  });

  it('handles empty ports array', async () => {
    const result = await buildCreateOpts('web', 'nginx', [], [], [], 'always', {});
    expect(result.ExposedPorts).toEqual({});
    expect(result.HostConfig.PortBindings).toEqual({});
  });
});

describe('buildCreateOpts - environment variables', () => {
  it('processes env array correctly', async () => {
    const env = [
      { key: 'NODE_ENV', value: 'production' },
      { key: 'DEBUG', value: 'false' },
    ];
    const result = await buildCreateOpts('app', 'node:18', env, [], [], 'always', {});
    expect(result.Env).toContain('NODE_ENV=production');
    expect(result.Env).toContain('DEBUG=false');
  });

  it('resolves {{SECRET:key}} syntax', async () => {
    mockGetSecret.mockResolvedValue('resolved-secret-value');

    const env = [
      { key: 'DB_PASSWORD', value: '{{SECRET:db-pass}}' },
    ];
    const result = await buildCreateOpts('app', 'node:18', env, [], [], 'always', {});
    expect(result.Env).toContain('DB_PASSWORD=resolved-secret-value');
    expect(mockGetSecret).toHaveBeenCalledWith('db-pass');
  });

  it('throws when secret key is not found', async () => {
    mockGetSecret.mockResolvedValue(null);

    const env = [
      { key: 'API_KEY', value: '{{SECRET:missing-key}}' },
    ];
    await expect(buildCreateOpts('app', 'node:18', env, [], [], 'always', {}))
      .rejects.toThrow('Secret missing-key not found');
  });
});

describe('buildCreateOpts - volumes', () => {
  it('uses direct host paths for non-backup type', async () => {
    const volumes = [
      { host: '/data/custom', container: '/app/data' },
    ];
    const result = await buildCreateOpts('app', 'node:18', [], volumes, [], 'always', {});
    expect(result.HostConfig.Binds).toContain('/data/custom:/app/data');
  });
});

describe('buildCreateOpts - memory and CPU', () => {
  it('converts memory MB to bytes', async () => {
    const resources = { memory: 512, cpu: 2 };
    const result = await buildCreateOpts('app', 'node:18', [], [], [], 'always', resources);
    expect(result.HostConfig.Memory).toBe(512 * 1024 * 1024);
    expect(result.HostConfig.NanoCPUs).toBe(2 * 1000000000);
  });

  it('defaults memory and cpu to 0 when not provided', async () => {
    const result = await buildCreateOpts('app', 'node:18', [], [], [], 'always', {});
    expect(result.HostConfig.Memory).toBe(0);
    expect(result.HostConfig.NanoCPUs).toBe(0);
  });
});

describe('buildCreateOpts - tmpfs', () => {
  it('parses tmpfs paths from comma-separated string', async () => {
    const result = await buildCreateOpts('app', 'node:18', [], [], [], 'always', {}, { tmpfs: '/tmp/cache,/run/shm' });
    expect(result.HostConfig.Tmpfs).toEqual({ '/tmp/cache': '', '/run/shm': '' });
  });

  it('handles empty tmpfs', async () => {
    const result = await buildCreateOpts('app', 'node:18', [], [], [], 'always', {}, { tmpfs: '' });
    expect(result.HostConfig.Tmpfs).toBeUndefined();
  });
});

describe('buildCreateOpts - shmSize parsing', () => {
  it('parses gigabytes', async () => {
    const result = await buildCreateOpts('app', 'node:18', [], [], [], 'always', {}, { shmSize: '2g' });
    expect(result.HostConfig.ShmSize).toBe(2 * 1024 * 1024 * 1024);
  });

  it('parses megabytes', async () => {
    const result = await buildCreateOpts('app', 'node:18', [], [], [], 'always', {}, { shmSize: '256M' });
    expect(result.HostConfig.ShmSize).toBe(256 * 1024 * 1024);
  });

  it('parses kilobytes', async () => {
    const result = await buildCreateOpts('app', 'node:18', [], [], [], 'always', {}, { shmSize: '64k' });
    expect(result.HostConfig.ShmSize).toBe(64 * 1024);
  });

  it('parses raw bytes', async () => {
    const result = await buildCreateOpts('app', 'node:18', [], [], [], 'always', {}, { shmSize: '8388608' });
    expect(result.HostConfig.ShmSize).toBe(8388608);
  });

  it('ignores when shmSize is not set', async () => {
    const result = await buildCreateOpts('app', 'node:18', [], [], [], 'always', {}, {});
    expect(result.HostConfig.ShmSize).toBeUndefined();
  });
});

describe('buildCreateOpts - devices parsing', () => {
  it('parses device mappings with all fields', async () => {
    const result = await buildCreateOpts('app', 'node:18', [], [], [], 'always', {}, {
      devices: '/dev/dri:/dev/dri:rwm,/dev/fuse:/dev/fuse:r',
    });
    expect(result.HostConfig.Devices).toHaveLength(2);
    expect(result.HostConfig.Devices[0].PathOnHost).toBe('/dev/dri');
    expect(result.HostConfig.Devices[0].PathInContainer).toBe('/dev/dri');
    expect(result.HostConfig.Devices[0].CgroupPermissions).toBe('rwm');
    expect(result.HostConfig.Devices[1].CgroupPermissions).toBe('r');
  });

  it('filters out invalid device entries', async () => {
    const result = await buildCreateOpts('app', 'node:18', [], [], [], 'always', {}, {
      devices: 'relative/path:/dev/null:rwm',
    });
    expect(result.HostConfig.Devices).toHaveLength(0);
  });

  it('handles empty devices string', async () => {
    const result = await buildCreateOpts('app', 'node:18', [], [], [], 'always', {}, { devices: '' });
    expect(result.HostConfig.Devices).toBeUndefined();
  });
});

describe('buildCreateOpts - stopGracePeriod', () => {
  it('sets StopTimeout when stopGracePeriod is provided', async () => {
    const result = await buildCreateOpts('app', 'node:18', [], [], [], 'always', {}, { stopGracePeriod: '30' });
    expect(result.StopTimeout).toBe(30);
  });

  it('does not set StopTimeout when not provided', async () => {
    const result = await buildCreateOpts('app', 'node:18', [], [], [], 'always', {}, {});
    expect(result.StopTimeout).toBeUndefined();
  });
});

describe('buildCreateOpts - privileged', () => {
  it('sets Privileged when enabled', async () => {
    const result = await buildCreateOpts('app', 'node:18', [], [], [], 'always', {}, { privileged: true });
    expect(result.HostConfig.Privileged).toBe(true);
  });

  it('defaults to false', async () => {
    const result = await buildCreateOpts('app', 'node:18', [], [], [], 'always', {}, {});
    expect(result.HostConfig.Privileged).toBe(false);
  });
});

describe('buildCreateOpts - network mode', () => {
  it('sets NetworkMode to web-proxy', async () => {
    const result = await buildCreateOpts('app', 'node:18', [], [], [], 'always', {});
    expect(result.HostConfig.NetworkMode).toBe('web-proxy');
  });
});
