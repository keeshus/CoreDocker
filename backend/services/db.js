import { Etcd3 } from 'etcd3';
import os from 'os';
import { isNodeUnsealed, encrypt, decrypt } from './secrets.js';

const etcdHosts = process.env.ETCD_HOSTS ? process.env.ETCD_HOSTS.split(',') : ['core-docker-etcd:2379', '127.0.0.1:2379'];
const etcd = new Etcd3({ hosts: etcdHosts });

/**
 * CoreDB Wrapper to handle encryption for keys starting with 'core/'
 */
class CoreDB {
  async put(key, value) {
    let finalValue = typeof value === 'string' ? value : JSON.stringify(value);
    if (key.startsWith('core/')) {
      finalValue = encrypt(finalValue);
    }
    return await etcd.put(key).value(finalValue);
  }

  async get(key) {
    const rawValue = await etcd.get(key).string();
    if (!rawValue) return null;
    
    let processedValue = rawValue;
    if (key.startsWith('core/')) {
      processedValue = decrypt(rawValue);
    }

    try {
      return JSON.parse(processedValue);
    } catch (e) {
      return processedValue;
    }
  }

  async getAll(prefix) {
    const all = await etcd.getAll().prefix(prefix).strings();
    const results = {};
    for (const [key, value] of Object.entries(all)) {
      let processedValue = value;
      if (key.startsWith('core/')) {
        processedValue = decrypt(value);
      }
      try {
        results[key] = JSON.parse(processedValue);
      } catch (e) {
        results[key] = processedValue;
      }
    }
    return results;
  }

  async delete(key) {
    return await etcd.delete().key(key);
  }
}

const db = new CoreDB();

export const waitForEtcd = async (retries = 60, delay = 2000) => {
  console.log(`Connecting to ETCD at ${etcdHosts}...`);
  for (let i = 0; i < retries; i++) {
    try {
      // Simple operation to check connection
      await etcd.put('connection-test').value(Date.now().toString());
      console.log('Successfully connected to ETCD.');
      return true;
    } catch (e) {
      // If we are getting UNAVAILABLE, we might need to recreate the client if it's stuck
      // but usually etcd3 handles reconnection. We just need to wait.
      console.error(`ETCD connection attempt ${i + 1} failed: ${e.message}`);
      if (e.code === 'DEADLINE_EXCEEDED' || e.message.includes('DNS resolution failed')) {
        console.error('Details: ETCD host might not be reachable or service is starting up.');
      }
      if (i === retries - 1) throw new Error(`Could not connect to ETCD after ${retries} attempts: ${e.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

const PREFIX = 'core/containers/';
const NODE_PREFIX = 'nodes/';
const GROUPS_PREFIX = 'core/groups/';

let nodeLease = null;

export const registerLocalNode = async (nodeId, name, ip) => {
  if (nodeLease) {
    try {
      await nodeLease.revoke();
    } catch (e) {
      console.warn(`[DB] Failed to revoke previous lease for Node ${nodeId}: ${e.message}`);
    }
  }
  
  nodeLease = etcd.lease(10); // 10 second TTL
  nodeLease.on('lost', () => {
    console.error('Node lease lost, re-registering...');
    registerLocalNode(nodeId, name, ip);
  });

  const node = {
    id: nodeId,
    name,
    ip,
    status: 'online',
    unsealed: isNodeUnsealed(),
    lastSeen: Date.now()
  };
  // Nodes are NOT encrypted, they use NODE_PREFIX which does not start with core/
  await nodeLease.put(`${NODE_PREFIX}${nodeId}`).value(JSON.stringify(node));
  console.log(`Node ${nodeId} registered with lease (Unsealed: ${node.unsealed}).`);
};

export const getNodes = async () => {
  try {
    const allNodes = await db.getAll(NODE_PREFIX);
    return Object.values(allNodes);
  } catch (e) {
    console.error(`Failed to get nodes from ETCD: ${e.message}`);
    throw e;
  }
};

export const saveNode = async (id, name, ip, status = 'offline', backupPath = '/data/backup', nonBackupPath = '/data/non-backup') => {
  const node = { id, name, ip, status, backupPath, nonBackupPath };
  await db.put(`${NODE_PREFIX}${id}`, node);
};

export const deleteNode = async (id) => {
  await db.delete(`${NODE_PREFIX}${id}`);
};

export const getLocalNodeConfig = async () => {
  const nodes = await getNodes();
  const interfaces = os.networkInterfaces();
  const localIps = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.family === 'IPv4') {
        localIps.push(iface.address);
      }
    }
  }

  const localNode = nodes.find(n => localIps.includes(n.ip));
  return localNode || { backupPath: '/data/backup', nonBackupPath: '/data/non-backup' };
};

export const getContainers = async () => {
  const allContainers = await db.getAll(PREFIX);
  return Object.values(allContainers);
};

export const getContainerById = async (id) => {
  return await db.get(`${PREFIX}${id}`);
};

export const getContainerByName = async (name) => {
  const containers = await getContainers();
  return containers.find(c => c.name === name) || null;
};

export const saveContainer = async (id, name, config, status, docker_id = null, current_node = null) => {
  const container = { id, name, config, status, docker_id, current_node };
  await db.put(`${PREFIX}${id}`, container);
};

export const updateContainerDockerId = async (id, docker_id) => {
  const c = await db.get(`${PREFIX}${id}`);
  if (c) {
    c.docker_id = docker_id;
    await db.put(`${PREFIX}${id}`, c);
  }
};

export const updateContainerStatus = async (id, status) => {
  const c = await db.get(`${PREFIX}${id}`);
  if (c) {
    c.status = status;
    await db.put(`${PREFIX}${id}`, c);
  }
};

export const deleteContainer = async (id) => {
  await db.delete(`${PREFIX}${id}`);
};

export const getGroups = async () => {
  const allGroups = await db.getAll(GROUPS_PREFIX);
  return Object.values(allGroups);
};

export const saveGroup = async (id, name, config) => {
  const group = { id, name, config };
  await db.put(`${GROUPS_PREFIX}${id}`, group);
};

export const deleteGroup = async (id) => {
  await db.delete(`${GROUPS_PREFIX}${id}`);
};

export default etcd;
