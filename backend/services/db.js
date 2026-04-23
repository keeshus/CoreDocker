import { Etcd3 } from 'etcd3';
import os from 'os';
import { isNodeSealed, encrypt, decrypt } from './secrets.js';

const etcdHosts = process.env.ETCD_HOSTS ? process.env.ETCD_HOSTS.split(',') : ['core-docker-etcd:2379'];
let etcd = new Etcd3({ hosts: etcdHosts });

export const closeEtcd = () => {
  console.log('[DB] Closing ETCD connection...');
  etcd.close();
};

/**
 * CoreDB Wrapper to handle encryption for keys starting with 'core/'
 */
class CoreDB {
  _shouldEncrypt(key) {
    return key.startsWith('core/') || key.startsWith('secrets/');
  }

  _processValue(key, value, decrypting = false) {
    if (!value) return null;
    let processed = value;

    if (this._shouldEncrypt(key)) {
      processed = decrypting ? decrypt(value) : encrypt(value);
    }

    if (decrypting) {
      try { return JSON.parse(processed); } catch (e) { return processed; }
    }
    return typeof processed === 'string' ? processed : JSON.stringify(processed);
  }

  async put(key, value) {
    const finalValue = this._processValue(key, value);
    return await etcd.put(key).value(finalValue);
  }

  async get(key) {
    const rawValue = await etcd.get(key).string();
    return this._processValue(key, rawValue, true);
  }

  async getAll(prefix) {
    const all = await etcd.getAll().prefix(prefix).strings();
    const results = {};
    for (const [key, value] of Object.entries(all)) {
      results[key] = this._processValue(key, value, true);
    }
    return results;
  }

  async delete(key) {
    return await etcd.delete().key(key);
  }
}

const db = new CoreDB();

export const waitForEtcd = async (retries = 60, delay = 2000) => {
  const host = etcdHosts[0];
  console.log(`Connecting to ETCD at ${host}...`);
  for (let i = 0; i < retries; i++) {
    try {
      // Simple operation to check connection
      await etcd.put('connection-test').value(Date.now().toString());
      console.log('Successfully connected to ETCD.');
      return true;
    } catch (e) {
      console.error(`ETCD connection attempt ${i + 1} failed: ${e.message}`);
      
      if (i === retries - 1) throw new Error(`Could not connect to ETCD after ${retries} attempts: ${e.message}`);
      
      // Force client to clear any cached DNS/connections by recreating it
      try {
        etcd.close();
        etcd = new Etcd3({ hosts: [host] });
      } catch (ce) {}

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
    sealed: isNodeSealed(),
    lastSeen: Date.now(),
    system: {
      totalMem: os.totalmem(),
      cpus: os.cpus().length
    }
  };
  // Nodes are NOT encrypted, they use NODE_PREFIX which does not start with core/
  await nodeLease.put(`${NODE_PREFIX}${nodeId}`).value(JSON.stringify(node));
  console.log(`Node ${nodeId} registered with lease (Sealed: ${node.sealed}).`);
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

export const saveNode = async (id, name, ip, status = 'offline') => {
  const node = {
    id,
    name,
    ip,
    status,
    backupPath: process.env.HOST_BACKUP_PATH || '/data/backup',
    nonBackupPath: process.env.HOST_NONBACKUP_PATH || '/data/non-backup'
  };
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

  // Find node by IP
  let localNode = nodes.find(n => localIps.includes(n.ip));
  
  // If not found, check if we have system-wide defaults
  if (!localNode) {
    return {
      backupPath: process.env.HOST_BACKUP_PATH || '/data/backup',
      nonBackupPath: process.env.HOST_NONBACKUP_PATH || '/data/non-backup'
    };
  }
  
  return localNode;
};

export const getContainers = async () => {
  const allContainers = await db.getAll(PREFIX);
  return Object.values(allContainers);
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
