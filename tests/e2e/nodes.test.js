import { describe, it, expect } from 'vitest';
import { api, waitForNode, unsealNode, NODES } from './helpers.js';

const PASSWORD = process.env.E2E_PASSWORD || 'TestCluster123!';

describe('Node management', () => {
  beforeAll(async () => {
    await waitForNode('node1', 300000);
    await unsealNode('node1', PASSWORD);
  }, 360000);

  it('lists all nodes', async () => {
    const { status, data } = await api('node1', '/api/nodes');
    expect(status).toBe(200);
    expect(data.length).toBeGreaterThanOrEqual(2);

    // Each node should have id, name, ip, status
    for (const node of data) {
      expect(node.id).toBeTruthy();
      expect(node.name).toBeTruthy();
      expect(node.ip).toBeTruthy();
      expect(node.status).toBeTruthy();
    }
  });

  it('renames a node', async () => {
    const { data: nodes } = await api('node1', '/api/nodes');
    const node2 = nodes.find(n => n.name === 'node-2' || n.ip === NODES.node2.publicIp);
    expect(node2).toBeDefined();

    const { status } = await api('node1', `/api/nodes/${node2.id}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'worker-east' }),
    });
    expect(status).toBe(200);

    // Verify rename persisted
    const { data: nodesAfter } = await api('node1', '/api/nodes');
    const renamed = nodesAfter.find(n => n.id === node2.id);
    expect(renamed.name).toBe('worker-east');
  });

  it('rejects names with invalid DNS characters', async () => {
    const { data: nodes } = await api('node1', '/api/nodes');
    const node = nodes[0];

    const { status, data } = await api('node1', `/api/nodes/${node.id}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'Bad Name With Spaces' }),
    });
    expect(status).toBe(400);
    expect(data.error).toContain('DNS-safe');
  });

  it('rejects rename with empty name', async () => {
    const { data: nodes } = await api('node1', '/api/nodes');
    const node = nodes[0];

    const { status } = await api('node1', `/api/nodes/${node.id}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ name: '' }),
    });
    expect(status).toBe(400);
  });
});
