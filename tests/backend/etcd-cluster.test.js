import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Skip retry delays without recursion
const realSetTimeout = setTimeout;
vi.stubGlobal('setTimeout', (fn, ms) => {
  if (ms >= 2000) return realSetTimeout(fn, 1);
  return realSetTimeout(fn, ms);
});

// Create a mock Docker exec stream with data + end events
function makeExecStream(data) {
  const stream = new EventEmitter();
  setImmediate(() => {
    stream.emit('data', data);
    stream.emit('end');
  });
  return stream;
}

// Mock filesystem (both named and default exports)
const mockFs = {
  store: {},
  existsSync: vi.fn((p) => p in mockFs.store),
  readFileSync: vi.fn((p) => {
    if (p in mockFs.store) return mockFs.store[p];
    throw new Error('ENOENT');
  }),
  writeFileSync: vi.fn((p, data) => { mockFs.store[p] = data; }),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn((p) => { delete mockFs.store[p]; }),
  rmSync: vi.fn((p, opts) => { delete mockFs.store[p]; }),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
  promises: {
    readdir: vi.fn(() => Promise.resolve([])),
    stat: vi.fn(() => Promise.resolve({ mtimeMs: Date.now() })),
    unlink: vi.fn(() => Promise.resolve()),
  },
};
vi.mock('fs', () => ({ default: mockFs, ...mockFs }));

vi.mock('../../backend/config.js', () => ({
  nodeId: 'test-node-1',
}));

// Shared mock for docker Container objects
// Creates proper stream objects for execWithOutput
function makeContainerMock(overrides = {}) {
  return {
    exec: vi.fn().mockResolvedValue({
      start: vi.fn().mockImplementation((cb) => {
        if (typeof cb === 'function') {
          cb(null, makeExecStream(Buffer.from('mock output')));
        }
        return Promise.resolve();
      }),
      inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
    }),
    stop: vi.fn().mockResolvedValue(),
    remove: vi.fn().mockResolvedValue(),
    start: vi.fn().mockResolvedValue(),
    inspect: vi.fn().mockResolvedValue({
      State: { Running: true },
      HostConfig: { PortBindings: { '2379/tcp': [{ HostPort: '2379' }] } },
    }),
    logs: vi.fn().mockResolvedValue(Buffer.from('')),
    ...overrides,
  };
}

// Mock docker
const mockDocker = {
  listContainers: vi.fn(),
  getContainer: vi.fn().mockImplementation(() => makeContainerMock()),
  createContainer: vi.fn().mockResolvedValue(makeContainerMock()),
  pull: vi.fn().mockResolvedValue(),
  modem: { followProgress: vi.fn((_stream, cb) => cb(null, {})) },
  listNetworks: vi.fn().mockResolvedValue([]),
  getImage: vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) }),
  getNetwork: vi.fn().mockReturnValue({ remove: vi.fn().mockResolvedValue() }),
};
vi.mock('../../backend/services/docker.js', () => ({ default: mockDocker }));

const mockDb = {
  get: vi.fn(),
  put: vi.fn().mockReturnThis(),
  getAll: vi.fn().mockReturnThis(),
  delete: vi.fn().mockReturnThis(),
  prefix: vi.fn().mockReturnThis(),
  keys: vi.fn().mockResolvedValue([]),
  strings: vi.fn().mockResolvedValue({}),
  string: vi.fn().mockResolvedValue(null),
  value: vi.fn().mockReturnThis(),
  lease: vi.fn(),
  election: vi.fn(),
};

vi.mock('../../backend/services/db.js', () => ({
  etcd: mockDb,
  getContainers: vi.fn().mockResolvedValue([]),
  getNodes: vi.fn().mockResolvedValue([]),
  saveNode: vi.fn().mockResolvedValue(),
  saveContainer: vi.fn(),
  updateEtcdHosts: vi.fn(),
  reconnectEtcd: vi.fn(),
  closeEtcd: vi.fn().mockResolvedValue(),
  registerLocalNode: vi.fn().mockResolvedValue(),
  waitForEtcd: vi.fn().mockResolvedValue(),
}));

vi.mock('../../backend/services/ephemeral-tasks.js', () => ({
  SYSTEM_NAMESPACE: '__system__',
  resolveHostPath: (p) => p || '/mnt/default',
  runEphemeralTask: vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 }),
}));

const {
  clearClusterConfig,
  addEtcdMember,
  migrateToCluster,
} = await import('../../backend/services/etcd-cluster.js');

beforeEach(() => {
  vi.clearAllMocks();
  mockFs.store = {};
});

// ===========================================================================
// clearClusterConfig
// ===========================================================================
describe('clearClusterConfig', () => {
  it('deletes the persisted cluster config file', () => {
    mockFs.store['/mnt/backup/__system__/etcd/cluster-config.json'] = '{}';
    clearClusterConfig();
    expect('__system__/etcd/cluster-config.json' in mockFs.store).toBe(false);
  });

  it('does not throw when file does not exist', () => {
    expect(() => clearClusterConfig()).not.toThrow();
  });
});

// ===========================================================================
// addEtcdMember — called by the primary node when a new node joins
// ===========================================================================
describe('addEtcdMember', () => {
  beforeEach(() => {
    mockDocker.listContainers.mockResolvedValue([{
      Id: 'etcd-c1',
      Names: ['/core-docker-etcd'],
      State: 'running',
    }]);
  });

  it('returns cluster info when member is added successfully', async () => {
    const memberAddOutput =
      'Member xyz added to cluster abc\n\n' +
      'ETCD_NAME="node-2"\n' +
      'ETCD_INITIAL_CLUSTER="node-1=http://10.0.0.1:2380,node-2=http://10.0.0.2:2380"\n' +
      'ETCD_INITIAL_CLUSTER_STATE="existing"\n';

    mockDocker.getContainer.mockReturnValue(makeContainerMock({
      exec: vi.fn().mockResolvedValue({
        start: vi.fn().mockImplementation((cb) => {
          cb(null, makeExecStream(Buffer.from(memberAddOutput)));
          return Promise.resolve();
        }),
        inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
      }),
    }));

    const result = await addEtcdMember('node-2', '10.0.0.2');
    expect(result.memberName).toBe('node-2');
    expect(result.initialCluster).toContain('node-2');
    expect(result.initialClusterState).toBe('existing');
  });
});

// ===========================================================================
// migrateToCluster — called on the joining node to switch to clustered mode
// ===========================================================================
describe('migrateToCluster', () => {
  const validConfig = {
    memberName: 'node-2',
    initialCluster: 'node-1=http://10.0.0.1:2380,node-2=http://10.0.0.2:2380',
    initialClusterState: 'existing',
    memberClientUrls: ['http://10.0.0.1:2379', 'http://10.0.0.2:2379'],
    clusterToken: 'test-token',
    authUsername: 'root',
    authPassword: 'pass',
  };

  beforeEach(() => {
    mockDocker.listContainers.mockResolvedValue([{
      Id: 'old-etcd',
      Names: ['/core-docker-etcd'],
      State: 'running',
    }]);
  });

  it('stops old etcd, creates clustered etcd, and persists config', async () => {
    const mockStop = vi.fn().mockResolvedValue();
    const mockRemove = vi.fn().mockResolvedValue();
    mockDocker.getContainer.mockReturnValue(makeContainerMock({ stop: mockStop, remove: mockRemove }));

    const result = await migrateToCluster(validConfig);

    // Returns true on success
    expect(result).toBe(true);

    // Old container was stopped and removed
    expect(mockStop).toHaveBeenCalled();
    expect(mockRemove).toHaveBeenCalled();

    // Cluster config persisted to disk at the end
    const key = '/mnt/backup/__system__/etcd/cluster-config.json';
    expect(mockFs.store[key]).toBeDefined();
    const written = JSON.parse(mockFs.store[key]);
    expect(written.members).toBeDefined();
    expect(written.clusterToken).toBe('test-token');
  });
});
