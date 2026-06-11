import { describe, it, expect } from 'vitest';
import { api, waitForNode, unsealNode, NODES } from './helpers.js';

const PASSWORD = process.env.E2E_PASSWORD || 'TestCluster123!';

describe('Cluster settings & secrets', () => {
  beforeAll(async () => {
    await Promise.all([
      waitForNode('node1', 300000),
      waitForNode('node2', 300000),
    ]);
    await unsealNode('node1', PASSWORD);
    await unsealNode('node2', PASSWORD);
  }, 360000);

  it('saves and reads cluster settings on node-1', async () => {
    const settings = {
      dnsVip: '10.0.0.53',
      dnsForwarder: '1.1.1.1',
      sshUser: 'coredocker',
      resticS3Endpoint: 's3.example.com',
      resticS3Bucket: 'test-bucket',
    };

    const { status: saveStatus } = await api('node1', '/api/settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    });
    expect(saveStatus).toBe(200);

    const { data } = await api('node1', '/api/settings');
    expect(data.dnsForwarder).toBe('1.1.1.1');
    expect(data.sshUser).toBe('coredocker');
    expect(data.resticS3Endpoint).toBe('s3.example.com');
  });

  it('saves TLS certificate credentials as encrypted secrets', async () => {
    const { status } = await api('node1', '/api/secrets', {
      method: 'POST',
      body: JSON.stringify({ key: '__system__/cert-domain', value: 'example.com' }),
    });
    expect(status).toBe(201);
  });

  it('bulk-reads secrets', async () => {
    const { status, data } = await api('node1', '/api/secrets/bulk-read', {
      method: 'POST',
      body: JSON.stringify({ keys: ['__system__/cert-domain'] }),
    });
    expect(status).toBe(200);
    expect(data['__system__/cert-domain']).toBe('example.com');
  });

  it('system secrets are NOT visible in the secrets tab list', async () => {
    const { data } = await api('node1', '/api/secrets');
    // __system__/ prefixed secrets should be filtered out
    const systemKeys = data.filter(k => k.startsWith('__system__/'));
    expect(systemKeys.length).toBe(0);
  });

  it('settings are readable from node-2 after being set on node-1', async () => {
    const { data } = await api('node2', '/api/settings');
    expect(data.resticS3Endpoint).toBe('s3.example.com');
  });
});
