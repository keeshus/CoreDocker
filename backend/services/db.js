import { Etcd3 } from 'etcd3';
import os from 'os';

const etcdHosts = process.env.ETCD_HOSTS ? process.env.ETCD_HOSTS.split(',') : ['core-docker-etcd:2379', '127.0.0.1:2379'];
const etcd = new Etcd3({ hosts: etcdHosts });

export const waitForEtcd = async (retries = 30, delay = 2000) => {
  console.log(`Connecting to ETCD at ${etcdHosts}...`);
  for (let i = 0; i < retries; i++) {
    try {
      // Simple operation to check connection
      await etcd.put('connection-test').value(Date.now().toString());
      console.log('Successfully connected to ETCD.');
      return true;
    } catch (e) {
      console.error(`ETCD connection attempt ${i + 1} failed: ${e.message}`);
      if (e.code === 'DEADLINE_EXCEEDED' || e.message.includes('DNS resolution failed')) {
        console.error('Details: ETCD host might not be reachable or service is starting up.');
      }
      if (i === retries - 1) throw new Error(`Could not connect to ETCD after ${retries} attempts: ${e.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

const PREFIX = 'containers/';
const NODE_PREFIX = 'nodes/';

let nodeLease = null;

export const registerLocalNode = async (nodeId, name, ip) => {
  if (nodeLease) {
    try { await nodeLease.revoke(); } catch (e) {}
  }
  
  nodeLease = etcd.lease(10); // 10 second TTL
  nodeLease.on('lost', () => {
    console.error('Node lease lost, re-registering...');
    registerLocalNode(nodeId, name, ip);
  });

  const node = { id: nodeId, name, ip, status: 'online', lastSeen: Date.now() };
  await nodeLease.put(`${NODE_PREFIX}${nodeId}`).value(JSON.stringify(node));
  console.log(`Node ${nodeId} registered with lease.`);
};

export const getNodes = async () => {
  try {
    const allNodes = await etcd.getAll().prefix(NODE_PREFIX).strings();
    return Object.values(allNodes).map(n => JSON.parse(n));
  } catch (e) {
    console.error(`Failed to get nodes from ETCD: ${e.message}`);
    throw e;
  }
};

export const saveNode = async (id, name, ip, status = 'offline', backupPath = '/data/backup', nonBackupPath = '/data/non-backup') => {
  const node = { id, name, ip, status, backupPath, nonBackupPath };
  await etcd.put(`${NODE_PREFIX}${id}`).value(JSON.stringify(node));
};

export const deleteNode = async (id) => {
  await etcd.delete().key(`${NODE_PREFIX}${id}`);
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
  const allContainers = await etcd.getAll().prefix(PREFIX).strings();
  return Object.values(allContainers).map(c => JSON.parse(c));
};

export const getContainerById = async (id) => {
  const containers = await getContainers();
  return containers.find(c => c.id === id) || null;
};

export const getContainerByName = async (name) => {
  const containers = await getContainers();
  return containers.find(c => c.name === name) || null;
};

export const saveContainer = async (id, name, config, status, docker_id = null, current_node = null) => {
  const container = { id, name, config, status, docker_id, current_node };
  await etcd.put(`${PREFIX}${id}`).value(JSON.stringify(container));
};

export const updateContainerDockerId = async (id, docker_id) => {
  const cString = await etcd.get(`${PREFIX}${id}`).string();
  if (cString) {
    const c = JSON.parse(cString);
    c.docker_id = docker_id;
    await etcd.put(`${PREFIX}${id}`).value(JSON.stringify(c));
  }
};

export const updateContainerStatus = async (id, status) => {
  const cString = await etcd.get(`${PREFIX}${id}`).string();
  if (cString) {
    const c = JSON.parse(cString);
    c.status = status;
    await etcd.put(`${PREFIX}${id}`).value(JSON.stringify(c));
  }
};

export const deleteContainer = async (id) => {
  await etcd.delete().key(`${PREFIX}${id}`);
};

export default etcd;
