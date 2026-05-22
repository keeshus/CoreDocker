import { describe, it, expect, vi, beforeEach } from 'vitest';

const etcdStore = {};
const mockLease = {
  put: vi.fn().mockReturnThis(),
  value: vi.fn().mockResolvedValue(),
  on: vi.fn().mockReturnThis(),
  revoke: vi.fn().mockResolvedValue(),
};

let mockPutImpl = vi.fn((key) => ({
  value: (val) => {
    etcdStore[key] = val;
    return Promise.resolve();
  },
}));

let mockGetAllImpl = vi.fn(() => ({
  prefix: (prefix) => ({
    strings: () => {
      const results = {};
      for (const [k, v] of Object.entries(etcdStore)) {
        if (k.startsWith(prefix)) results[k] = v;
      }
      return Promise.resolve(results);
    },
  }),
}));

const mockEtcd3 = {
  get: vi.fn((key) => ({
    string: () => Promise.resolve(etcdStore[key] || null),
  })),
  put: function(key) { return mockPutImpl(key); },
  delete: vi.fn(() => ({
    key: (k) => {
      delete etcdStore[k];
      return Promise.resolve();
    },
  })),
  getAll: function() { return mockGetAllImpl(); },
  lease: vi.fn(() => mockLease),
  close: vi.fn(),
};

const mockOs = {
  networkInterfaces: vi.fn(),
  totalmem: vi.fn().mockReturnValue(8589934592),
  cpus: vi.fn().mockReturnValue([{}, {}, {}, {}]),
};

vi.mock('etcd3', () => ({ Etcd3: function() { return mockEtcd3; } }));
vi.mock('os', () => ({ default: mockOs, ...mockOs }));

const mockSecrets = {
  isNodeSealed: vi.fn().mockReturnValue(false),
  encrypt: vi.fn((v) => `encrypted:${v}`),
  decrypt: vi.fn((v) => {
    if (typeof v === 'string' && v.startsWith('encrypted:')) return v.replace('encrypted:', '');
    return v;
  }),
};

vi.mock('../../backend/services/secrets.js', () => mockSecrets);
const {
  closeEtcd, recreateEtcdClient, waitForEtcd,
  registerLocalNode, getNodes, saveNode, deleteNode,
  getLocalNodeConfig, getContainers, getContainerByName,
  saveContainer, updateContainerDockerId, deleteContainer,
  getGroups, saveGroup, deleteGroup,
} = await import('../../backend/services/db.js');

beforeEach(() => {
  for (const key of Object.keys(etcdStore)) {
    delete etcdStore[key];
  }
  vi.clearAllMocks();
  mockPutImpl = vi.fn((key) => ({
    value: (val) => {
      etcdStore[key] = val;
      return Promise.resolve();
    },
  }));
  mockGetAllImpl = vi.fn(() => ({
    prefix: (prefix) => ({
      strings: () => {
        const results = {};
        for (const [k, v] of Object.entries(etcdStore)) {
          if (k.startsWith(prefix)) results[k] = v;
        }
        return Promise.resolve(results);
      },
    }),
  }));
  mockEtcd3.put = function(key) { return mockPutImpl(key); };
  mockEtcd3.getAll = function() { return mockGetAllImpl(); };
  mockEtcd3.get.mockImplementation((key) => ({
    string: () => Promise.resolve(etcdStore[key] || null),
  }));
  mockEtcd3.lease.mockReturnValue(mockLease);
  mockOs.networkInterfaces.mockReturnValue({});
});

describe('waitForEtcd', () => {
  it('returns true when connection succeeds', async () => {
    const result = await waitForEtcd(3, 5);
    expect(result).toBe(true);
  });

  it('throws after exhausting retries', async () => {
    mockPutImpl = vi.fn(() => ({
      value: () => Promise.reject(new Error('connection refused')),
    }));
    mockEtcd3.put = function(key) { return mockPutImpl(key); };
    await expect(waitForEtcd(2, 5)).rejects.toThrow('Could not connect to ETCD after 2 attempts');
  });
});

describe('registerLocalNode', () => {
  it('creates a node entry with lease', async () => {
    await registerLocalNode('node-1', 'Primary', '192.168.1.10');
    expect(mockEtcd3.lease).toHaveBeenCalledWith(10);
    expect(mockLease.put).toHaveBeenCalledWith('nodes/node-1');
  });
});

describe('saveNode / getNodes / deleteNode', () => {
  it('saveNode stores node with correct structure', async () => {
    await saveNode('n1', 'Alpha', '10.0.0.1', 'online');
    const stored = Object.values(etcdStore).find(v => {
      try {
        const p = JSON.parse(v);
        return p.id === 'n1';
      } catch { return false; }
    });
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored);
    expect(parsed.name).toBe('Alpha');
    expect(parsed.ip).toBe('10.0.0.1');
    expect(parsed.status).toBe('online');
  });

  it('getNodes returns all nodes', async () => {
    etcdStore['nodes/n1'] = JSON.stringify({ id: 'n1', name: 'A', ip: '1.1.1.1', status: 'online' });
    etcdStore['nodes/n2'] = JSON.stringify({ id: 'n2', name: 'B', ip: '2.2.2.2', status: 'offline' });

    const nodes = await getNodes();
    expect(nodes).toHaveLength(2);
    expect(nodes.find(n => n.id === 'n1').name).toBe('A');
    expect(nodes.find(n => n.id === 'n2').name).toBe('B');
  });

  it('deleteNode removes the node entry', async () => {
    etcdStore['nodes/n1'] = 'data';
    await deleteNode('n1');
    expect(etcdStore['nodes/n1']).toBeUndefined();
  });
});

describe('saveContainer / getContainers / getContainerByName / deleteContainer', () => {
  it('saveContainer stores container with correct structure', async () => {
    const config = { image: 'nginx', memoryLimit: 512, cpuLimit: 1 };
    await saveContainer('cid-123', 'web-nginx', config, 'running', 'docker-abc', 'node-1');

    // Verify data is encrypted at rest (in real impl, mock prepends 'encrypted:')
    const key = Object.keys(etcdStore).find(k => k.startsWith('core/containers/'));
    expect(key).toBeDefined();
    expect(etcdStore[key]).toContain('encrypted:');

    // Verify getContainers decrypts correctly
    const containers = await getContainers();
    const saved = containers.find(c => c.id === 'cid-123');
    expect(saved).toBeDefined();
    expect(saved.name).toBe('web-nginx');
    expect(saved.config).toEqual(config);
    expect(saved.status).toBe('running');
    expect(saved.docker_id).toBe('docker-abc');
    expect(saved.current_node).toBe('node-1');
  });

  it('getContainers returns all containers', async () => {
    etcdStore['core/containers/c1'] = JSON.stringify({ id: 'c1', name: 'a', config: {}, status: 'running' });
    etcdStore['core/containers/c2'] = JSON.stringify({ id: 'c2', name: 'b', config: {}, status: 'stopped' });

    const containers = await getContainers();
    expect(containers).toHaveLength(2);
  });

  it('getContainers ignores malformed entries', async () => {
    etcdStore['core/containers/c1'] = 'not-json';
    etcdStore['core/containers/c2'] = JSON.stringify({ id: 'c2', name: 'valid', config: {}, status: 'running' });

    const containers = await getContainers();
    expect(containers).toHaveLength(1);
    expect(containers[0].id).toBe('c2');
  });

  it('getContainers returns empty array on error', async () => {
    mockGetAllImpl = vi.fn(() => ({
      prefix: () => ({
        strings: () => Promise.reject(new Error('db error')),
      }),
    }));
    mockEtcd3.getAll = function() { return mockGetAllImpl(); };

    const containers = await getContainers();
    expect(containers).toEqual([]);
  });

  it('getContainerByName finds container by name', async () => {
    etcdStore['core/containers/c1'] = JSON.stringify({ id: 'c1', name: 'target-container', config: {}, status: 'running' });
    etcdStore['core/containers/c2'] = JSON.stringify({ id: 'c2', name: 'other', config: {}, status: 'running' });

    const found = await getContainerByName('target-container');
    expect(found).not.toBeNull();
    expect(found.id).toBe('c1');

    const notFound = await getContainerByName('nonexistent');
    expect(notFound).toBeNull();
  });

  it('deleteContainer removes the container', async () => {
    etcdStore['core/containers/c1'] = 'data';
    await deleteContainer('c1');
    expect(etcdStore['core/containers/c1']).toBeUndefined();
  });

  it('updateContainerDockerId updates docker_id', async () => {
    etcdStore['core/containers/c1'] = 'encrypted:' + JSON.stringify({ id: 'c1', name: 'web', config: {}, status: 'running', docker_id: null });

    await updateContainerDockerId('c1', 'new-docker-id-123');

    const containers = await getContainers();
    const updated = containers.find(c => c.id === 'c1');
    expect(updated.docker_id).toBe('new-docker-id-123');
  });
});

describe('getLocalNodeConfig', () => {
  it('returns node matching local IP', async () => {
    etcdStore['nodes/n1'] = JSON.stringify({ id: 'n1', name: 'Node1', ip: '10.0.0.5', status: 'online' });
    mockOs.networkInterfaces.mockReturnValue({
      eth0: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
    });

    const config = await getLocalNodeConfig();
    expect(config.id).toBe('n1');
    expect(config.name).toBe('Node1');
  });

  it('returns defaults when no local IP matches', async () => {
    etcdStore['nodes/n1'] = JSON.stringify({ id: 'n1', name: 'Node1', ip: '10.0.0.5', status: 'online' });
    mockOs.networkInterfaces.mockReturnValue({
      eth0: [{ address: '192.168.1.1', family: 'IPv4', internal: false }],
    });

    const config = await getLocalNodeConfig();
    expect(config.backupPath).toBeDefined();
    expect(config.nonBackupPath).toBeDefined();
    expect(config.id).toBeUndefined();
  });

  it('skips internal interfaces', async () => {
    mockOs.networkInterfaces.mockReturnValue({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    });

    const config = await getLocalNodeConfig();
    expect(config.backupPath).toBeDefined();
  });
});

describe('Group CRUD operations', () => {
  it('saveGroup stores group', async () => {
    await saveGroup('g1', 'web-services', { highAvailability: true, targetNodes: ['n1', 'n2'] });
    const key = Object.keys(etcdStore).find(k => k.startsWith('core/groups/'));
    expect(key).toBeDefined();
    const raw = etcdStore[key];
    expect(raw).toBeDefined();
    // Verify data is encrypted at rest
    expect(raw).toContain('encrypted:');
    // Verify getGroups decrypts correctly
    const groups = await getGroups();
    const saved = groups.find(g => g.id === 'g1');
    expect(saved).toBeDefined();
    expect(saved.name).toBe('web-services');
    expect(saved.config.highAvailability).toBe(true);
  });

  it('getGroups returns all groups', async () => {
    etcdStore['core/groups/g1'] = JSON.stringify({ id: 'g1', name: 'A', config: {} });

    const groups = await getGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('A');
  });

  it('deleteGroup removes the group', async () => {
    etcdStore['core/groups/g1'] = 'data';
    await deleteGroup('g1');
    expect(etcdStore['core/groups/g1']).toBeUndefined();
  });
});
