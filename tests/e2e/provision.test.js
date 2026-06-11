import { describe, it, expect } from 'vitest';
import { api, waitForNode, NODES } from './helpers.js';

const PASSWORD = process.env.E2E_PASSWORD || 'TestCluster123!';
const nodeKeys = Object.keys(NODES);

describe('Cluster provisioning', () => {
  // Wait for all nodes to be healthy before any tests
  beforeAll(async () => {
    await Promise.all(nodeKeys.map(k => waitForNode(k, 300000)));
  }, 360000);

  it('all 3 nodes respond to status endpoint', async () => {
    for (const key of nodeKeys) {
      const { status, data } = await api(key, '/api/system/status');
      expect(status).toBe(200);
      expect(data.initialized).toBeDefined();
      expect(data.sealed).toBeDefined();
    }
  });

  it('all 3 nodes have unique node IDs', async () => {
    const ids = new Set();
    for (const key of nodeKeys) {
      const { data } = await api(key, '/api/system/status');
      ids.add(data.nodeId);
    }
    expect(ids.size).toBe(3);
  });

  it('all 3 nodes are initially sealed', async () => {
    for (const key of nodeKeys) {
      const { data } = await api(key, '/api/system/status');
      expect(data.sealed).toBe(true);
    }
  });
});

// Persist setup state for other test files
export const clusterState = { initialized: false };
