import { describe, it, expect, vi, beforeEach } from 'vitest';

const testContainers = [];
const testNodes = [];
const savedContainers = [];

const mockDb = {
  getContainers: vi.fn().mockImplementation(() => Promise.resolve(testContainers)),
  getNodes: vi.fn().mockImplementation(() => Promise.resolve(testNodes)),
  saveContainer: vi.fn().mockImplementation((id, name, config, status, dockerId, nodeId) => {
    savedContainers.push({ id, name, config, status, docker_id: dockerId, current_node: nodeId });
    return Promise.resolve();
  }),
};

vi.mock('../services/db.js', () => {
  const mockEtcd = {
    put: vi.fn().mockReturnThis(),
    get: vi.fn(),
    election: vi.fn(),
    getAll: vi.fn(),
  };
  return {
    default: mockEtcd,
    getContainers: () => mockDb.getContainers(),
    getNodes: () => mockDb.getNodes(),
    saveContainer: (id, name, config, status, dockerId, nodeId) =>
      mockDb.saveContainer(id, name, config, status, dockerId, nodeId),
  };
});

const { runOrchestrationLoop } = await import('../services/orchestrator.js');

beforeEach(() => {
  testContainers.length = 0;
  testNodes.length = 0;
  savedContainers.length = 0;
  vi.clearAllMocks();
});

function makeNode(id, totalMem = 16000000000, cpus = 8) {
  return { id, name: id, ip: `10.0.0.${id.slice(-1)}`, system: { totalMem, cpus } };
}

function makeContainer(id, name, ha, current_node, resources, ha_allowed_nodes) {
  return {
    id, name,
    config: { ha, resources, ha_allowed_nodes: ha_allowed_nodes || [] },
    status: 'running',
    current_node,
  };
}

describe('orchestrator HA scheduling', () => {
  it('does not reschedule non-HA containers', async () => {
    testNodes.push(makeNode('node-1'), makeNode('node-2'));
    testContainers.push(makeContainer('c1', 'web', false, 'node-1', { memoryLimit: 512, cpuLimit: 1 }));

    await runOrchestrationLoop();

    expect(mockDb.saveContainer).not.toHaveBeenCalled();
  });

  it('does not reschedule HA containers on alive nodes', async () => {
    testNodes.push(makeNode('node-1'), makeNode('node-2'));
    testContainers.push(
      makeContainer('c1', 'web', true, 'node-1', { memoryLimit: 512, cpuLimit: 1 })
    );

    await runOrchestrationLoop();
    expect(mockDb.saveContainer).not.toHaveBeenCalled();
  });

  it('reschedules orphaned HA container to available node', async () => {
    const node1 = makeNode('node-1', 16000000000, 8);
    const node2 = makeNode('node-2', 16000000000, 8);
    testNodes.push(node1, node2);
    testContainers.push(
      makeContainer('c1', 'web', true, 'dead-node', { memoryLimit: 512, cpuLimit: 1 })
    );

    await runOrchestrationLoop();
    expect(mockDb.saveContainer).toHaveBeenCalled();

    const savedCall = mockDb.saveContainer.mock.calls[0];
    const savedNodeId = savedCall[5];
    expect(['node-1', 'node-2']).toContain(savedNodeId);
    expect(savedCall[1]).toBe('web');
  });

  it('filters candidates by ha_allowed_nodes', async () => {
    const node1 = makeNode('node-1', 16000000000, 8);
    const node2 = makeNode('node-2', 32000000000, 16);
    const node3 = makeNode('node-3', 8000000000, 4);
    testNodes.push(node1, node2, node3);
    testContainers.push(
      makeContainer('c1', 'web', true, 'dead-node', { memoryLimit: 512, cpuLimit: 1 }, ['node-2'])
    );

    await runOrchestrationLoop();
    expect(mockDb.saveContainer).toHaveBeenCalled();

    const savedNodeId = mockDb.saveContainer.mock.calls[0][5];
    expect(savedNodeId).toBe('node-2');
  });

  it('skips HA container when no valid candidates remain', async () => {
    const node1 = makeNode('node-1');
    testNodes.push(node1);
    testContainers.push(
      makeContainer('c1', 'web', true, 'dead-node', { memoryLimit: 512, cpuLimit: 1 }, ['node-2'])
    );

    await runOrchestrationLoop();
    expect(mockDb.saveContainer).not.toHaveBeenCalled();
  });

  it('sorts candidates by free CPU then free memory', async () => {
    const nodeLowCpu = makeNode('node-1', 32000000000, 2);
    const nodeHighCpu = makeNode('node-2', 8000000000, 16);
    testNodes.push(nodeLowCpu, nodeHighCpu);
    testContainers.push(
      makeContainer('c1', 'web', true, 'dead-node', { memoryLimit: 512, cpuLimit: 1 })
    );

    await runOrchestrationLoop();
    expect(mockDb.saveContainer).toHaveBeenCalled();

    const savedNodeId = mockDb.saveContainer.mock.calls[0][5];
    expect(savedNodeId).toBe('node-2');
  });

  it('sorts by free memory when CPU is equal', async () => {
    const nodeLowMem = makeNode('node-lowmem', 4000000000, 8);
    const nodeHighMem = makeNode('node-highmem', 32000000000, 8);
    testNodes.push(nodeLowMem, nodeHighMem);
    testContainers.push(
      makeContainer('c1', 'web', true, 'dead-node', { memoryLimit: 512, cpuLimit: 1 })
    );

    await runOrchestrationLoop();
    expect(mockDb.saveContainer).toHaveBeenCalled();

    const savedNodeId = mockDb.saveContainer.mock.calls[0][5];
    expect(savedNodeId).toBe('node-highmem');
  });

  it('does not crash with empty nodes list', async () => {
    testContainers.push(
      makeContainer('c1', 'web', true, 'dead-node', { memoryLimit: 512, cpuLimit: 1 })
    );

    await expect(runOrchestrationLoop()).resolves.toBeUndefined();
  });

  it('does not crash with empty containers list', async () => {
    testNodes.push(makeNode('node-1'));

    await expect(runOrchestrationLoop()).resolves.toBeUndefined();
  });

  it('accounts for existing container resource usage when sorting', async () => {
    const node1 = makeNode('node-1', 16000000000, 8);
    const node2 = makeNode('node-2', 16000000000, 8);
    testNodes.push(node1, node2);

    testContainers.push(
      { id: 'existing', name: 'existing', config: { ha: false, resources: { memoryLimit: 2048, cpuLimit: 4 } }, status: 'running', current_node: 'node-1' },
      makeContainer('orphan', 'web', true, 'dead-node', { memoryLimit: 512, cpuLimit: 1 })
    );

    await runOrchestrationLoop();
    expect(mockDb.saveContainer).toHaveBeenCalled();

    const savedNodeId = mockDb.saveContainer.mock.calls[0][5];
    expect(savedNodeId).toBe('node-2');
  });

  it('selects node with more free CPU when one has existing load', async () => {
    const node1 = makeNode('node-1', 16000000000, 4);
    const node2 = makeNode('node-2', 16000000000, 8);
    testNodes.push(node1, node2);

    testContainers.push(
      { id: 'existing', name: 'existing', config: { ha: false, resources: { memoryLimit: 1024, cpuLimit: 3 } }, status: 'running', current_node: 'node-1' },
      makeContainer('orphan', 'web', true, 'dead-node', { memoryLimit: 512, cpuLimit: 2 })
    );

    await runOrchestrationLoop();
    const savedNodeId = mockDb.saveContainer.mock.calls[0][5];
    expect(savedNodeId).toBe('node-2');
  });
});
