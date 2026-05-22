import docker from './docker.js';
import { SYSTEM_NAMESPACE } from './ephemeral-tasks.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const ETCD_IMAGE = process.env.ETCD_IMAGE || 'gcr.io/etcd-development/etcd:v3.6.8';
const CONTAINER_NAME = 'core-docker-etcd';
const CLUSTER_CONFIG_FILE = `${SYSTEM_NAMESPACE}/etcd/cluster-config.json`;

/**
 * Parse `etcdctl member add` output to extract cluster join info.
 * Expected output format:
 *   Member <id> added to cluster <cluster-id>
 *
 *   ETCD_NAME="<name>"
 *   ETCD_INITIAL_CLUSTER="<cluster-string>"
 *   ETCD_INITIAL_CLUSTER_STATE="existing"
 */
const parseEtcdctlAddOutput = (output) => {
  const nameMatch = output.match(/ETCD_NAME="([^"]+)"/);
  const clusterMatch = output.match(/ETCD_INITIAL_CLUSTER="([^"]+)"/);
  const stateMatch = output.match(/ETCD_INITIAL_CLUSTER_STATE="([^"]+)"/);

  return {
    name: nameMatch ? nameMatch[1] : null,
    initialCluster: clusterMatch ? clusterMatch[1] : null,
    initialClusterState: stateMatch ? stateMatch[1] : 'existing',
  };
};

/**
 * Build the member name from NODE_NAME for etcd cluster membership.
 */
const getEtcdNodeName = () => {
  return process.env.NODE_NAME || 'node-1';
};

/**
 * Get the node's backhaul IP for etcd advertise URLs.
 * Falls back to the Docker container name for local-only setups.
 */
const getAdvertiseIp = () => {
  const ip = process.env.NODE_IP;
  if (ip && ip !== '127.0.0.1') return ip;
  return null; // No routable IP — use Docker DNS name
};

/**
 * Read cluster config from host file (written during join migration).
 */
const readClusterConfig = () => {
  const backupPath = process.env.HOST_BACKUP_PATH;
  if (!backupPath) return null;
  const filePath = path.join(backupPath, CLUSTER_CONFIG_FILE);
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.warn(`[ETCD] Failed to read cluster config: ${e.message}`);
  }
  return null;
};

/**
 * Write cluster config to host file for persistence across restarts.
 */
const writeClusterConfig = (config) => {
  const backupPath = process.env.HOST_BACKUP_PATH || '/data/backup';
  const dir = path.join(backupPath, `${SYSTEM_NAMESPACE}/etcd`);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(backupPath, CLUSTER_CONFIG_FILE), JSON.stringify(config, null, 2));
    console.log('[ETCD] Cluster config saved.');
  } catch (e) {
    console.warn(`[ETCD] Failed to save cluster config: ${e.message}`);
  }
};

/**
 * Delete the cluster config file (used when leaving a cluster).
 */
export const clearClusterConfig = () => {
  const backupPath = process.env.HOST_BACKUP_PATH || '/data/backup';
  const filePath = path.join(backupPath, CLUSTER_CONFIG_FILE);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.warn(`[ETCD] Failed to clear cluster config: ${e.message}`);
  }
};

/**
 * Helper: pull etcd image if not present.
 */
const ensureEtcdImage = async () => {
  try {
    await docker.getImage(ETCD_IMAGE).inspect();
  } catch (err) {
    console.log(`Pulling ${ETCD_IMAGE}...`);
    await new Promise((resolve, reject) => {
      docker.pull(ETCD_IMAGE, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err, res) => err ? reject(err) : resolve(res));
      });
    });
  }
};

/**
 * Helper: find the app-net Docker network (handles compose project prefixing).
 */
const findAppNet = async () => {
  const networks = await docker.listNetworks();
  const target = networks.find(n => n.Name === 'app-net' || n.Name.endsWith('_app-net'));
  return target ? target.Name : 'app-net';
};

/**
 * Get the host path for ETCD data directory.
 */
const getEtcdDataHostPath = () => {
  const backupPath = process.env.HOST_BACKUP_PATH || '/data/backup';
  return `${backupPath}/${SYSTEM_NAMESPACE}/etcd-data`;
};

/**
 * Bootstrap ETCD on this node.
 *
 * Behaviour:
 * - If a cluster config file exists (from a previous join), start etcd as a
 *   clustered member using the saved peer URLs.
 * - Otherwise, start a standalone etcd with NODE_IP in advertise URLs and
 *   port bindings so it can accept cross-node peer connections.
 */
export const bootstrapEtcd = async () => {
  // Check if we are running in an external compose mode
  if (process.env.NODE_ID) {
    console.log(`[ETCD] Node ${process.env.NODE_ID} skipping individual bootstrap, assuming cluster ETCD is available.`);
    return true;
  }

  const etcdName = getEtcdNodeName();
  const advertiseIp = getAdvertiseIp();

  // If container already exists, just ensure it's running
  try {
    const container = docker.getContainer(CONTAINER_NAME);
    const info = await container.inspect();
    if (!info.State.Running) {
      await container.start();
    }
    console.log('ETCD container is already running.');
    return true;
  } catch (e) {
    if (e.statusCode !== 404) {
      console.error('Error checking ETCD container:', e);
      return false;
    }
  }

  // No existing container — bootstrap a new one
  console.log('Bootstrapping ETCD container...');
  await ensureEtcdImage();
  const networkName = await findAppNet();
  const dataHostPath = getEtcdDataHostPath();
  const configPath = `${process.env.HOST_BACKUP_PATH || '/data/backup'}/${SYSTEM_NAMESPACE}/etcd/config`;

  // Check if we have a saved cluster config (from a previous join)
  const clusterConfig = readClusterConfig();

  let cmd;
  let portBindings = {};

  if (clusterConfig) {
    // Clustered mode — use saved peer URLs
    console.log('[ETCD] Found cluster config, starting as clustered member.');
    const members = clusterConfig.members || [];
    const initialCluster = members.map(m => `${m.name}=http://${m.ip}:2380`).join(',');
    const memberEntry = members.find(m => m.name === etcdName);
    const memberIp = memberEntry ? memberEntry.ip : (advertiseIp || '127.0.0.1');

    cmd = [
      'etcd',
      '--name', etcdName,
      '--listen-client-urls', 'http://0.0.0.0:2379',
      '--advertise-client-urls', `http://${memberIp}:2379`,
      '--listen-peer-urls', 'http://0.0.0.0:2380',
      '--initial-advertise-peer-urls', `http://${memberIp}:2380`,
      '--initial-cluster', initialCluster,
      '--initial-cluster-state', 'existing',
      '--initial-cluster-token', clusterConfig.clusterToken || 'core-docker-cluster',
      '--data-dir', '/etcd-data',
      '--logger', 'zap',
      '--log-outputs', 'stderr',
    ];

    portBindings = {
      '2379/tcp': [{ HostPort: '2379' }],
      '2380/tcp': [{ HostPort: '2380' }],
    };
  } else {
    // Standalone mode — use NODE_IP for advertise URLs if available
    const advertiseUrl = advertiseIp
      ? `http://${advertiseIp}:2379`
      : `http://${CONTAINER_NAME}:2379`;
    const peerUrl = advertiseIp
      ? `http://${advertiseIp}:2380`
      : `http://${CONTAINER_NAME}:2380`;

    const clusterToken = crypto.randomBytes(16).toString('hex');

    cmd = [
      'etcd',
      '--name', etcdName,
      '--listen-client-urls', 'http://0.0.0.0:2379',
      '--advertise-client-urls', advertiseUrl,
      '--listen-peer-urls', 'http://0.0.0.0:2380',
      '--initial-advertise-peer-urls', peerUrl,
      '--initial-cluster', `${etcdName}=${peerUrl}`,
      '--initial-cluster-token', clusterToken,
      '--initial-cluster-state', 'new',
      '--data-dir', '/etcd-data',
      '--logger', 'zap',
      '--log-outputs', 'stderr',
    ];

    // Publish ports if we have a routable IP (for cross-node clustering)
    if (advertiseIp) {
      portBindings = {
        '2379/tcp': [{ HostPort: '2379' }],
        '2380/tcp': [{ HostPort: '2380' }],
      };
    }
  }

  const createOpts = {
    Image: ETCD_IMAGE,
    name: CONTAINER_NAME,
    Cmd: cmd,
    HostConfig: {
      User: '0:0',
      RestartPolicy: { Name: 'always' },
      Binds: [
        `${dataHostPath}:/etcd-data`,
        `${configPath}:/etc/etcd:ro`,
      ],
      PortBindings: portBindings,
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [networkName]: {},
      },
    },
    ExposedPorts: portBindings['2379/tcp'] ? { '2379/tcp': {}, '2380/tcp': {} } : {},
  };

  try {
    const newContainer = await docker.createContainer(createOpts);
    await newContainer.start();
    console.log('[ETCD] Container created and started.');

    // Enable etcd authentication on first bootstrap (not on restart from config)
    if (!clusterConfig) {
      const rootUser = crypto.randomBytes(16).toString('hex');
      const rootPass = crypto.randomBytes(32).toString('hex');

      // Wait for etcd to be ready, then set up auth
      for (let i = 0; i < 10; i++) {
        try {
          const addExec = await newContainer.exec({
            Cmd: ['etcdctl', 'user', 'add', `root:${rootPass}`],
            AttachStdout: true, AttachStderr: true,
          });
          const addResult = await new Promise((resolve) => {
            addExec.start(async (err, stream) => {
              if (err) { resolve(false); return; }
              let data = '';
              stream.on('data', c => data += c.toString());
              stream.on('end', async () => {
                const insp = await addExec.inspect();
                resolve(insp.ExitCode === 0);
              });
            });
          });
          if (!addResult) { await new Promise(r => setTimeout(r, 1000)); continue; }

          const enableExec = await newContainer.exec({
            Cmd: ['etcdctl', 'auth', 'enable'],
            AttachStdout: true, AttachStderr: true,
          });
          await new Promise((resolve) => {
            enableExec.start(async (err, stream) => {
              if (err) { resolve(false); return; }
              stream.on('end', async () => {
                const insp = await enableExec.inspect();
                resolve(insp.ExitCode === 0);
              });
            });
          });

          // Save credentials
          const authPath = `${process.env.HOST_BACKUP_PATH || '/data/backup'}/${SYSTEM_NAMESPACE}/etcd/auth.json`;
          const dir = path.dirname(authPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(authPath, JSON.stringify({ username: rootUser, password: rootPass }, null, 2));
          console.log('[ETCD] Authentication enabled.');
          break;
        } catch (e) {
          console.log(`[ETCD] Waiting for etcd readiness (auth setup)... ${e.message}`);
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }

    // Save cluster config for standalone bootstrap so subsequent restarts
    // and joining nodes can read the generated cluster token.
    if (!clusterConfig) {
      const selfIp = advertiseIp || '127.0.0.1';
      writeClusterConfig({
        clusterToken,
        members: [{ name: etcdName, ip: selfIp }],
      });
    }

    return true;
  } catch (err) {
    console.error('[ETCD] Failed to create container:', err.message);
    return false;
  }
};

/**
 * Add a new member to the local ETCD cluster and return structured join info.
 *
 * Returns: {
 *   memberName: string,
 *   initialCluster: string (full peer-urls string),
 *   initialClusterState: 'existing',
 *   allClientUrls: string[] (for ETCD_HOSTS)
 * }
 */
export const addEtcdMember = async (nodeName, nodeIp) => {
  try {
    const container = docker.getContainer(CONTAINER_NAME);
    const exec = await container.exec({
      Cmd: ['etcdctl', 'member', 'add', nodeName, '--peer-urls', `http://${nodeIp}:2380`],
      AttachStdout: true,
      AttachStderr: true,
    });

    const output = await new Promise((resolve, reject) => {
      exec.start(async (err, stream) => {
        if (err) return reject(err);
        let data = '';
        stream.on('data', chunk => data += chunk.toString());
        stream.on('end', async () => {
          const inspectData = await exec.inspect();
          if (inspectData.ExitCode === 0) resolve(data);
          else reject(new Error(`etcdctl member add failed: ${data}`));
        });
      });
    });

    console.log(`[ETCD] Member add output:`, output);

    const parsed = parseEtcdctlAddOutput(output);

    // Get the full member list to build client URLs
    const listExec = await container.exec({
      Cmd: ['etcdctl', 'member', 'list', '--write-out=json'],
      AttachStdout: true,
      AttachStderr: true,
    });

    const memberListJson = await new Promise((resolve, reject) => {
      listExec.start(async (err, stream) => {
        if (err) return reject(err);
        let data = '';
        stream.on('data', chunk => data += chunk.toString());
        stream.on('end', () => resolve(data));
      });
    });

    let allClientUrls = [];
    try {
      const memberList = JSON.parse(memberListJson);
      if (memberList.members) {
        allClientUrls = memberList.members.map(m => {
          // Each member advertises its client URLs — extract the host:port
          const url = m.clientURLs && m.clientURLs[0];
          if (url) {
            // Use the host part (IP:2379) from the first client URL
            return url;
          }
          return null;
        }).filter(Boolean);
      }
    } catch (e) {
      console.warn(`[ETCD] Failed to parse member list: ${e.message}`);
    }

    const clusterConfig = readClusterConfig();

    // Read etcd auth credentials to share with joining nodes
    let authCreds;
    try {
      const backupPath = process.env.HOST_BACKUP_PATH || '/data/backup';
      const authFile = path.join(backupPath, `${SYSTEM_NAMESPACE}/etcd/auth.json`);
      if (fs.existsSync(authFile)) {
        authCreds = JSON.parse(fs.readFileSync(authFile, 'utf8'));
      }
    } catch (e) {
      console.warn(`[ETCD] Failed to read auth credentials: ${e.message}`);
    }

    return {
      memberName: parsed.name || nodeName,
      initialCluster: parsed.initialCluster,
      initialClusterState: parsed.initialClusterState || 'existing',
      allClientUrls,
      clusterToken: clusterConfig ? clusterConfig.clusterToken : undefined,
      authUsername: authCreds?.username,
      authPassword: authCreds?.password,
    };
  } catch (error) {
    console.error(`Failed to add ETCD member ${nodeName}:`, error);
    throw error;
  }
};

/**
 * Migrate from standalone etcd to clustered etcd.
 *
 * 1. Stops and removes the existing standalone etcd container
 * 2. Wipes the local etcd data directory
 * 3. Creates a new etcd container with the cluster config
 * 4. Saves cluster config to host file
 *
 * @param {object} clusterInfo - from addEtcdMember()
 * @param {string} clusterInfo.memberName
 * @param {string} clusterInfo.initialCluster
 * @param {string} clusterInfo.initialClusterState
 * @param {string[]} clusterInfo.allClientUrls - for ETCD_HOSTS
 */
export const migrateToCluster = async (clusterInfo) => {
  const { memberName, initialCluster, initialClusterState, allClientUrls } = clusterInfo;
  const selfIp = process.env.NODE_IP || '127.0.0.1';

  console.log(`[ETCD] Migrating to clustered mode as ${memberName}...`);

  // 1. Stop and remove existing etcd container
  try {
    const existing = docker.getContainer(CONTAINER_NAME);
    await existing.inspect();
    console.log('[ETCD] Stopping existing standalone container...');
    await existing.stop();
    await existing.remove();
    console.log('[ETCD] Existing container removed.');
  } catch (e) {
    if (e.statusCode !== 404) {
      console.warn(`[ETCD] Unexpected error removing container: ${e.message}`);
    }
  }

  // 2. Wipe old data directory (required for fresh cluster join)
  const dataHostPath = getEtcdDataHostPath();
  const backupPath = process.env.HOST_BACKUP_PATH || '/data/backup';
  const dataDir = path.join(backupPath, `${SYSTEM_NAMESPACE}/etcd-data`);
  try {
    if (fs.existsSync(dataDir)) {
      // Remove contents but keep the directory
      fs.rmSync(dataDir, { recursive: true, force: true });
      console.log('[ETCD] Old data directory wiped.');
    }
  } catch (e) {
    console.warn(`[ETCD] Failed to wipe data directory: ${e.message}`);
  }

  // 3. Create new etcd container with cluster config
  await ensureEtcdImage();
  const networkName = await findAppNet();
  const configPath = `${backupPath}/${SYSTEM_NAMESPACE}/etcd/config`;

  // Build the initial-cluster from the cluster info
  // The initialCluster from etcdctl already has all members' peer URLs
  const cmd = [
    'etcd',
    '--name', memberName,
    '--listen-client-urls', 'http://0.0.0.0:2379',
    '--advertise-client-urls', `http://${selfIp}:2379`,
    '--listen-peer-urls', 'http://0.0.0.0:2380',
    '--initial-advertise-peer-urls', `http://${selfIp}:2380`,
    '--initial-cluster', initialCluster,
    '--initial-cluster-state', initialClusterState,
    '--initial-cluster-token', clusterInfo.clusterToken || 'core-docker-cluster',
    '--data-dir', '/etcd-data',
    '--logger', 'zap',
    '--log-outputs', 'stderr',
  ];

  const createOpts = {
    Image: ETCD_IMAGE,
    name: CONTAINER_NAME,
    Cmd: cmd,
    HostConfig: {
      User: '0:0',
      RestartPolicy: { Name: 'always' },
      Binds: [
        `${dataHostPath}:/etcd-data`,
        `${configPath}:/etc/etcd:ro`,
      ],
      PortBindings: {
        '2379/tcp': [{ HostPort: '2379' }],
        '2380/tcp': [{ HostPort: '2380' }],
      },
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [networkName]: {},
      },
    },
    ExposedPorts: { '2379/tcp': {}, '2380/tcp': {} },
  };

  try {
    const newContainer = await docker.createContainer(createOpts);
    await newContainer.start();
    console.log('[ETCD] Clustered etcd container created and started.');
  } catch (err) {
    console.error('[ETCD] Failed to create clustered container:', err.message);
    throw err;
  }

  // 4. Save cluster config for future restarts
  const memberIps = [];
  if (initialCluster) {
    initialCluster.split(',').forEach(part => {
      const url = part.split('=')[1];
      if (url) {
        const ipPort = url.replace(/^http:\/\//, '');
        const ip = ipPort.split(':')[0];
        const name = part.split('=')[0];
        memberIps.push({ name, ip });
      }
    });
  }

  writeClusterConfig({
    clusterToken: clusterInfo.clusterToken || 'core-docker-cluster',
    members: memberIps,
  });

  console.log(`[ETCD] Migration complete. Cluster members: ${memberIps.map(m => m.name).join(', ')}`);
  return true;
};
