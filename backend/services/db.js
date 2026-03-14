import { Etcd3 } from 'etcd3';

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

export const getNodes = async () => {
  try {
    const allNodes = await etcd.getAll().prefix(NODE_PREFIX).strings();
    return Object.values(allNodes).map(n => JSON.parse(n));
  } catch (e) {
    console.error(`Failed to get nodes from ETCD: ${e.message}`);
    throw e;
  }
};

export const saveNode = async (id, name, ip, status = 'offline') => {
  const node = { id, name, ip, status };
  await etcd.put(`${NODE_PREFIX}${id}`).value(JSON.stringify(node));
};

export const deleteNode = async (id) => {
  await etcd.delete().key(`${NODE_PREFIX}${id}`);
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

export const saveContainer = async (id, name, config, status, docker_id = null) => {
  const container = { id, name, config, status, docker_id };
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
