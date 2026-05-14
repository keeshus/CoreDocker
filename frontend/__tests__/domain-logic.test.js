import {
  calculateCPU,
  calculateMemory,
  getExitCodeDescription,
  parseEnvFromInitialData,
  buildContainerPayload,
  filterContainersByNode,
  validatePasswordChange,
  parseHaAllowedNodes,
} from '../lib/domain-logic';

// ---------------------------------------------------------------------------
// calculateCPU
// ---------------------------------------------------------------------------
describe('calculateCPU', () => {
  it('returns "0.00%" for null/undefined stats', () => {
    expect(calculateCPU(null)).toBe('0.00%');
    expect(calculateCPU(undefined)).toBe('0.00%');
  });

  it('returns "0.00%" when cpu_usage is missing', () => {
    expect(calculateCPU({})).toBe('0.00%');
  });

  it('returns "0.00%" when precpu_usage is missing', () => {
    expect(calculateCPU({ cpu_usage: { total_usage: 100 } })).toBe('0.00%');
  });

  it('returns "0.00%" when systemDelta is zero', () => {
    const stats = {
      cpu_usage: { total_usage: 200, precpu_usage: { total_usage: 100 } },
      system_cpu_usage: 100,
      precpu_usage: { total_usage: 100, system_cpu_usage: 100 },
    };
    expect(calculateCPU(stats)).toBe('0.00%');
  });

  it('calculates CPU percentage correctly with default 1 CPU', () => {
    const stats = {
      cpu_usage: { total_usage: 200, precpu_usage: { total_usage: 100 } },
      system_cpu_usage: 200,
      precpu_usage: { total_usage: 100, system_cpu_usage: 100 },
    };
    expect(calculateCPU(stats)).toBe('100.00%');
  });

  it('accounts for online_cpus', () => {
    const stats = {
      cpu_usage: { total_usage: 200, precpu_usage: { total_usage: 100 } },
      system_cpu_usage: 200,
      precpu_usage: { total_usage: 100, system_cpu_usage: 100 },
      online_cpus: 4,
    };
    expect(calculateCPU(stats)).toBe('400.00%');
  });

  it('handles small CPU deltas', () => {
    const stats = {
      cpu_usage: { total_usage: 500, precpu_usage: { total_usage: 495 } },
      system_cpu_usage: 10000,
      precpu_usage: { total_usage: 495, system_cpu_usage: 9900 },
      online_cpus: 2,
    };
    expect(calculateCPU(stats)).toBe('10.00%');
  });

  it('returns "0.00%" when cpuDelta is zero', () => {
    const stats = {
      cpu_usage: { total_usage: 100, precpu_usage: { total_usage: 100 } },
      system_cpu_usage: 200,
      precpu_usage: { system_cpu_usage: 100 },
    };
    expect(calculateCPU(stats)).toBe('0.00%');
  });

  it('uses default online_cpus of 1 when not provided', () => {
    const stats = {
      cpu_usage: { total_usage: 150, precpu_usage: { total_usage: 100 } },
      system_cpu_usage: 200,
      precpu_usage: { total_usage: 100, system_cpu_usage: 100 },
    };
    expect(calculateCPU(stats)).toBe('50.00%');
  });

  it('handles zero online_cpus gracefully', () => {
    const stats = {
      cpu_usage: { total_usage: 200, precpu_usage: { total_usage: 100 } },
      system_cpu_usage: 200,
      precpu_usage: { system_cpu_usage: 100 },
      online_cpus: 0,
    };
    expect(calculateCPU(stats)).toBe('0.00%');
  });
});

// ---------------------------------------------------------------------------
// calculateMemory
// ---------------------------------------------------------------------------
describe('calculateMemory', () => {
  it('returns "0.00%" for null/undefined stats', () => {
    expect(calculateMemory(null)).toBe('0.00%');
    expect(calculateMemory(undefined)).toBe('0.00%');
  });

  it('returns "0.00%" when usage is missing', () => {
    expect(calculateMemory({ limit: 1073741824 })).toBe('0.00%');
  });

  it('returns "0.00%" when limit is missing', () => {
    expect(calculateMemory({ usage: 524288000 })).toBe('0.00%');
  });

  it('calculates memory percentage correctly', () => {
    // 512 MB used out of 1024 MB
    const stats = { usage: 536870912, limit: 1073741824 };
    const result = calculateMemory(stats);
    expect(result).toMatch(/^512\.00 MB \/ 1024\.00 MB \(50\.00%\)$/);
  });

  it('handles 100% memory usage', () => {
    const stats = { usage: 1073741824, limit: 1073741824 };
    const result = calculateMemory(stats);
    expect(result).toMatch(/\(100\.00%\)$/);
  });

  it('handles very small memory usage', () => {
    const stats = { usage: 1024, limit: 1073741824 }; // 1 KB out of 1 GB
    const result = calculateMemory(stats);
    expect(result).toContain('MB /');
    expect(result).toMatch(/\(0\.00%\)$/);
  });

  it('rounds to two decimal places', () => {
    const stats = { usage: 536870912 + 102400, limit: 1073741824 }; // ~512.1 MB
    const result = calculateMemory(stats);
    expect(result).toMatch(/512\.10 MB \/ 1024\.00 MB/);
  });

  it('handles values in bytes that are not MB-aligned', () => {
    const stats = { usage: 123456789, limit: 998244353 };
    const result = calculateMemory(stats);
    expect(result).toMatch(/^\d+\.\d{2} MB \/ \d+\.\d{2} MB \(\d+\.\d{2}%\)$/);
  });
});

// ---------------------------------------------------------------------------
// getExitCodeDescription
// ---------------------------------------------------------------------------
describe('getExitCodeDescription', () => {
  it('returns description for exit code 1', () => {
    expect(getExitCodeDescription(1)).toContain('Generic error');
  });

  it('returns description for exit code 126', () => {
    expect(getExitCodeDescription(126)).toContain('cannot execute');
  });

  it('returns description for exit code 127', () => {
    expect(getExitCodeDescription(127)).toContain('not found');
  });

  it('returns description for exit code 130', () => {
    expect(getExitCodeDescription(130)).toContain('Ctrl+C');
  });

  it('returns description for exit code 137', () => {
    expect(getExitCodeDescription(137)).toContain('SIGKILL');
  });

  it('returns description for exit code 139', () => {
    expect(getExitCodeDescription(139)).toContain('Segmentation fault');
  });

  it('returns description for exit code 143', () => {
    expect(getExitCodeDescription(143)).toContain('SIGTERM');
  });

  it('returns null for unknown exit codes', () => {
    expect(getExitCodeDescription(0)).toBeNull();
    expect(getExitCodeDescription(2)).toBeNull();
    expect(getExitCodeDescription(255)).toBeNull();
    expect(getExitCodeDescription(-1)).toBeNull();
  });

  it('returns null for undefined/null', () => {
    expect(getExitCodeDescription(undefined)).toBeNull();
    expect(getExitCodeDescription(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseEnvFromInitialData
// ---------------------------------------------------------------------------
describe('parseEnvFromInitialData', () => {
  it('returns empty array for null/undefined input', () => {
    expect(parseEnvFromInitialData(null)).toEqual([]);
    expect(parseEnvFromInitialData(undefined)).toEqual([]);
  });

  it('returns empty array for empty array', () => {
    expect(parseEnvFromInitialData([])).toEqual([]);
  });

  it('marks plain env vars as non-secret', () => {
    const env = [{ key: 'DB_HOST', value: 'localhost' }];
    const result = parseEnvFromInitialData(env);
    expect(result).toEqual([{ key: 'DB_HOST', value: 'localhost', isSecret: false }]);
  });

  it('parses {{SECRET:key}} pattern and marks as secret', () => {
    const env = [{ key: 'API_KEY', value: '{{SECRET:MY_SECRET}}' }];
    const result = parseEnvFromInitialData(env);
    expect(result).toEqual([{ key: 'API_KEY', value: 'MY_SECRET', isSecret: true }]);
  });

  it('handles mixed env vars', () => {
    const env = [
      { key: 'DB_HOST', value: 'localhost' },
      { key: 'API_KEY', value: '{{SECRET:CLOUDFLARE_KEY}}' },
      { key: 'DEBUG', value: 'true' },
    ];
    const result = parseEnvFromInitialData(env);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ key: 'DB_HOST', value: 'localhost', isSecret: false });
    expect(result[1]).toEqual({ key: 'API_KEY', value: 'CLOUDFLARE_KEY', isSecret: true });
    expect(result[2]).toEqual({ key: 'DEBUG', value: 'true', isSecret: false });
  });

  it('handles {{SECRET:}} with empty key as non-secret (empty capture group does not match)', () => {
    const env = [{ key: 'TOKEN', value: '{{SECRET:}}' }];
    const result = parseEnvFromInitialData(env);
    expect(result[0].isSecret).toBe(false);
    expect(result[0].value).toBe('{{SECRET:}}');
  });

  it('preserves other properties on env objects', () => {
    const env = [{ key: 'FOO', value: 'bar', extra: true }];
    const result = parseEnvFromInitialData(env);
    expect(result[0].extra).toBe(true);
    expect(result[0].isSecret).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildContainerPayload
// ---------------------------------------------------------------------------
describe('buildContainerPayload', () => {
  const baseFormData = {
    name: 'my-app',
    image: 'nginx:latest',
    restartPolicy: 'unless-stopped',
    env: [{ key: '', value: '', isSecret: false }],
    volumes: [{ type: 'backup', host: '', container: '' }],
    ports: [{ host: '', container: '', ip: '0.0.0.0' }],
    resources: { cpu: '', memory: '' },
    proxy: { enabled: false, uri: '', port: '', domain: '', sslCert: '', sslKey: '' },
    group: '',
    ha: false,
    ha_allowed_nodes: [],
    tmpfs: '',
    stopGracePeriod: '',
    shmSize: '',
    devices: '',
    privileged: false,
    current_node: '',
  };

  it('filters out empty env entries and wraps secret values', () => {
    const formData = {
      ...baseFormData,
      env: [
        { key: 'DB_HOST', value: 'localhost', isSecret: false },
        { key: '', value: '', isSecret: false },
        { key: 'API_KEY', value: 'my-key', isSecret: true },
      ],
    };
    const payload = buildContainerPayload(formData);
    expect(payload.env).toEqual([
      { key: 'DB_HOST', value: 'localhost' },
      { key: 'API_KEY', value: '{{SECRET:my-key}}' },
    ]);
  });

  it('filters volumes where type=custom but no host path', () => {
    const formData = {
      ...baseFormData,
      volumes: [
        { type: 'backup', host: '', container: '/data' },
        { type: 'custom', host: '', container: '/var' },
        { type: 'custom', host: '/real', container: '/mnt' },
      ],
    };
    const payload = buildContainerPayload(formData);
    expect(payload.volumes).toHaveLength(2);
    expect(payload.volumes[0].container).toBe('/data');
    expect(payload.volumes[1].container).toBe('/mnt');
  });

  it('filters volumes with empty container path', () => {
    const formData = {
      ...baseFormData,
      volumes: [
        { type: 'backup', host: '', container: '/valid' },
        { type: 'backup', host: '', container: '' },
      ],
    };
    const payload = buildContainerPayload(formData);
    expect(payload.volumes).toHaveLength(1);
  });

  it('parses port host/container as integers and keeps null for empty host', () => {
    const formData = {
      ...baseFormData,
      ports: [
        { host: '8080', container: '80', ip: '0.0.0.0' },
        { host: '', container: '3000', ip: '127.0.0.1' },
      ],
    };
    const payload = buildContainerPayload(formData);
    expect(payload.ports).toEqual([
      { host: 8080, container: 80, ip: '0.0.0.0' },
      { host: null, container: 3000, ip: '127.0.0.1' },
    ]);
  });

  it('filters out ports without container port', () => {
    const formData = {
      ...baseFormData,
      ports: [
        { host: '8080', container: '80', ip: '0.0.0.0' },
        { host: '9090', container: '', ip: '0.0.0.0' },
      ],
    };
    const payload = buildContainerPayload(formData);
    expect(payload.ports).toHaveLength(1);
  });

  it('parses resources to null when empty', () => {
    const payload = buildContainerPayload(baseFormData);
    expect(payload.resources).toEqual({ cpu: null, memory: null });
  });

  it('parses resources as numbers when provided', () => {
    const formData = {
      ...baseFormData,
      resources: { cpu: '2.5', memory: '512' },
    };
    const payload = buildContainerPayload(formData);
    expect(payload.resources).toEqual({ cpu: 2.5, memory: 512 });
  });

  it('converts proxy.port to integer when proxy is enabled', () => {
    const formData = {
      ...baseFormData,
      proxy: { enabled: true, uri: '/app', port: '8080', domain: '', sslCert: '', sslKey: '' },
    };
    const payload = buildContainerPayload(formData);
    expect(payload.proxy.port).toBe(8080);
  });

  it('does not convert proxy.port when proxy is disabled', () => {
    const formData = {
      ...baseFormData,
      proxy: { enabled: false, uri: '', port: '8080', domain: '', sslCert: '', sslKey: '' },
    };
    const payload = buildContainerPayload(formData);
    // port should stay as string when not enabled
    expect(payload.proxy.port).toBe('8080');
  });

  it('passes through all other fields unchanged', () => {
    const formData = {
      ...baseFormData,
      name: 'test-container',
      image: 'alpine:latest',
      restartPolicy: 'always',
      group: 'web',
      ha: true,
      ha_allowed_nodes: ['node-1'],
      tmpfs: '/tmp',
      stopGracePeriod: '30',
      shmSize: '64m',
      devices: '/dev/dri',
      privileged: true,
      current_node: 'node-2',
    };
    const payload = buildContainerPayload(formData);
    expect(payload.name).toBe('test-container');
    expect(payload.image).toBe('alpine:latest');
    expect(payload.restartPolicy).toBe('always');
    expect(payload.group).toBe('web');
    expect(payload.ha).toBe(true);
    expect(payload.ha_allowed_nodes).toEqual(['node-1']);
    expect(payload.tmpfs).toBe('/tmp');
    expect(payload.stopGracePeriod).toBe('30');
    expect(payload.shmSize).toBe('64m');
    expect(payload.devices).toBe('/dev/dri');
    expect(payload.privileged).toBe(true);
    expect(payload.current_node).toBe('node-2');
  });
});

// ---------------------------------------------------------------------------
// filterContainersByNode
// ---------------------------------------------------------------------------
describe('filterContainersByNode', () => {
  const containers = [
    { Names: ['/app-1'], current_node: 'node-1' },
    { Names: ['/app-2'], current_node: 'node-2' },
    { Names: ['/system-1'], current_node: 'master' },
    { Names: ['/named-container'] },
  ];

  it('returns all containers when selectedNode is null/undefined', () => {
    expect(filterContainersByNode(containers, null)).toHaveLength(4);
    expect(filterContainersByNode(containers, undefined)).toHaveLength(4);
  });

  it('returns empty array for empty containers', () => {
    const result = filterContainersByNode([], { id: 'node-1', name: 'node-1' });
    expect(result).toEqual([]);
  });

  it('filters by current_node matching node name (returns master-match container too)', () => {
    const selectedNode = { id: 'n1', name: 'node-1' };
    const result = filterContainersByNode(containers, selectedNode);
    // Matches /app-1 (current_node === 'node-1') AND /system-1 (master + node-1)
    expect(result).toHaveLength(2);
    expect(result.map(c => c.Names[0])).toContain('/app-1');
  });

  it('filters by current_node matching node id', () => {
    const selectedNode = { id: 'node-2', name: 'worker-2' };
    const result = filterContainersByNode(containers, selectedNode);
    expect(result).toHaveLength(1);
    expect(result[0].Names[0]).toBe('/app-2');
  });

  it('matches master containers with node-1 name', () => {
    const selectedNode = { id: 'n1', name: 'node-1' };
    const result = filterContainersByNode(containers, selectedNode);
    // Should match both /app-1 (current_node === 'node-1') and /system-1 (master + node-1)
    expect(result).toHaveLength(2);
    expect(result.map(c => c.Names[0])).toContain('/app-1');
    expect(result.map(c => c.Names[0])).toContain('/system-1');
  });

  it('matches containers by name containing node name', () => {
    const selectedNode = { id: 'n3', name: 'named' };
    const result = filterContainersByNode(containers, selectedNode);
    expect(result).toHaveLength(1);
    expect(result[0].Names[0]).toBe('/named-container');
  });

  it('returns no containers when no criteria match', () => {
    const selectedNode = { id: 'other', name: 'other-node' };
    const result = filterContainersByNode(containers, selectedNode);
    expect(result).toHaveLength(0);
  });

  it('handles containers with undefined current_node', () => {
    const selectedNode = { id: 'n1', name: 'node-1' };
    const result = filterContainersByNode(containers, selectedNode);
    // The container with no current_node should not match node-1
    expect(result.find(c => c.Names[0] === '/named-container')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validatePasswordChange
// ---------------------------------------------------------------------------
describe('validatePasswordChange', () => {
  it('returns valid when passwords match', () => {
    const result = validatePasswordChange({ current: 'old', next: 'new123', confirm: 'new123' });
    expect(result).toEqual({ valid: true });
  });

  it('returns error when passwords do not match', () => {
    const result = validatePasswordChange({ current: 'old', next: 'new123', confirm: 'different' });
    expect(result).toEqual({ valid: false, error: "New passwords don't match!" });
  });

  it('returns error when confirm is empty', () => {
    const result = validatePasswordChange({ current: 'old', next: 'new123', confirm: '' });
    expect(result.valid).toBe(false);
  });

  it('returns valid when both next and confirm are empty (passwords match)', () => {
    const result = validatePasswordChange({ current: 'old', next: '', confirm: '' });
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseHaAllowedNodes
// ---------------------------------------------------------------------------
describe('parseHaAllowedNodes', () => {
  it('splits comma-separated values and trims whitespace', () => {
    expect(parseHaAllowedNodes('node-1, node-2, node-3')).toEqual(['node-1', 'node-2', 'node-3']);
  });

  it('returns empty array for empty string', () => {
    expect(parseHaAllowedNodes('')).toEqual([]);
  });

  it('returns empty array for whitespace-only string', () => {
    expect(parseHaAllowedNodes('   ')).toEqual([]);
  });

  it('filters out empty entries', () => {
    expect(parseHaAllowedNodes('node-1,,node-2,')).toEqual(['node-1', 'node-2']);
  });

  it('returns single value as single-element array', () => {
    expect(parseHaAllowedNodes('node-1')).toEqual(['node-1']);
  });
});
