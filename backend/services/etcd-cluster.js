import docker from './docker.js';
import { SYSTEM_NAMESPACE, resolveHostPath } from './ephemeral-tasks.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const ETCD_IMAGE = process.env.ETCD_IMAGE || 'gcr.io/etcd-development/etcd:v3.6.8';
const CONTAINER_NAME = 'core-docker-etcd';
const CLUSTER_CONFIG_FILE = `${SYSTEM_NAMESPACE}/etcd/cluster-config.json`;
const BACKUP_MOUNT = '/mnt/backup';

/**
 * Run a command inside the etcd container via Docker exec with a timeout.
 * Resolves true if exit code is 0, false on non-zero, throws on timeout/error.
 */
async function execWithTimeout(container, cmd, timeoutMs = 20000) {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Exec timed out after ${timeoutMs}ms: ${cmd.join(' ')}`)), timeoutMs);
    exec.start(async (err, stream) => {
      if (err) { clearTimeout(timer); reject(err); return; }
      // Drain stream data to prevent backpressure — the 'end' event won't fire
      // if the stream buffer isn't consumed.
      stream.on('data', () => {});
      stream.on('end', async () => {
        clearTimeout(timer);
        try {
          const insp = await exec.inspect();
          resolve(insp.ExitCode === 0);
        } catch (inspectErr) {
          resolve(false);
        }
      });
    });
  });
}

/**
 * Like execWithTimeout but also captures stdout/stderr output.
 * Resolves { success: boolean, output: string }. Throws on timeout/error.
 */
async function execWithOutput(container, cmd, timeoutMs = 30000) {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Exec timed out after ${timeoutMs}ms: ${cmd.join(' ')}`)), timeoutMs);
    exec.start(async (err, stream) => {
      if (err) { clearTimeout(timer); reject(err); return; }
      let data = '';
      stream.on('data', chunk => data += chunk.toString());
      stream.on('end', async () => {
        clearTimeout(timer);
        try {
          const insp = await exec.inspect();
          resolve({ success: insp.ExitCode === 0, output: data });
        } catch (inspectErr) {
          resolve({ success: false, output: data });
        }
      });
    });
  });
}

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
  const filePath = path.join(BACKUP_MOUNT, CLUSTER_CONFIG_FILE);
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
  const dir = path.join(BACKUP_MOUNT, `${SYSTEM_NAMESPACE}/etcd`);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(BACKUP_MOUNT, CLUSTER_CONFIG_FILE), JSON.stringify(config, null, 2));
    console.log('[ETCD] Cluster config saved.');
  } catch (e) {
    console.warn(`[ETCD] Failed to save cluster config: ${e.message}`);
  }
};

/**
 * Delete the cluster config file (used when leaving a cluster).
 */
export const clearClusterConfig = () => {
  const filePath = path.join(BACKUP_MOUNT, CLUSTER_CONFIG_FILE);
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
  const backupPath = resolveHostPath(process.env.HOST_BACKUP_PATH, '/mnt/backup');
  return `${backupPath}/${SYSTEM_NAMESPACE}/etcd-data`;
};

/**
 * Read etcd auth credentials from the saved auth file.
 * Returns a credentials string array like ['--user', 'root:password'] or [].
 */
const getAuthArgs = () => {
  try {
    const authFile = path.join(BACKUP_MOUNT, `${SYSTEM_NAMESPACE}/etcd/auth.json`);
    if (fs.existsSync(authFile)) {
      const creds = JSON.parse(fs.readFileSync(authFile, 'utf8'));
      if (creds.username && creds.password) return `--user ${creds.username}:${creds.password}`.split(' ');
    }
  } catch (e) {
    console.warn(`[ETCD] Failed to read auth credentials: ${e.message}`);
  }
  return [];
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
  if (process.env.NODE_ID) {
    console.log(`[ETCD] Node ${process.env.NODE_ID} skipping individual bootstrap, assuming cluster ETCD is available.`);
    return true;
  }

  const etcdName = getEtcdNodeName();
  const advertiseIp = getAdvertiseIp();

  // If container already exists, verify it's healthy before reusing
  try {
    const container = docker.getContainer(CONTAINER_NAME);
    const info = await container.inspect();
    if (!info.State.Running) {
      console.log('[ETCD] Existing container stopped, starting...');
      await container.start();
      // Wait a moment for etcd to be ready
      await new Promise(r => setTimeout(r, 3000));
    } else {
      console.log('[ETCD] Existing container found, checking health...');
    }

    // Verify etcd is actually responsive — retry a few times to tolerate
    // transient CPU spikes or network glitches before concluding it's dead.
    const authArgs = getAuthArgs();
    const healthCmd = ['etcdctl', ...authArgs, 'endpoint', 'health'];
    let healthy = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        healthy = await execWithTimeout(container, healthCmd, 10000);
        if (healthy) break;
      } catch (e) {
        console.warn(`[ETCD] Health check attempt ${attempt + 1} failed: ${e.message}`);
      }
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    }
    if (healthy) {
      console.log('[ETCD] Existing container is healthy, reusing.');
      return true;
    }

    // Container is running but etcd is unresponsive after retries — wipe and recreate.
    console.log('[ETCD] Container running but etcd unresponsive after retries, wiping and recreating...');
    try {
      await container.stop();
      await container.remove();
    } catch (e) {
      console.warn(`[ETCD] Failed to remove stale container: ${e.message}`);
    }

    // Wipe data directory and cluster config so we get a clean bootstrap
    const dataDir = path.join(BACKUP_MOUNT, `${SYSTEM_NAMESPACE}/etcd-data`);
    try {
      if (fs.existsSync(dataDir)) {
        fs.rmSync(dataDir, { recursive: true, force: true });
        console.log('[ETCD] Wiped stale etcd data directory.');
      }
    } catch (e) {
      console.warn(`[ETCD] Failed to wipe data directory: ${e.message}`);
    }
    try {
      if (fs.existsSync(path.join(BACKUP_MOUNT, CLUSTER_CONFIG_FILE))) {
        fs.unlinkSync(path.join(BACKUP_MOUNT, CLUSTER_CONFIG_FILE));
        console.log('[ETCD] Wiped stale cluster config.');
      }
    } catch (e) {
      console.warn(`[ETCD] Failed to wipe cluster config: ${e.message}`);
    }
    // Fall through to create a fresh container below
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
  const configPath = `${resolveHostPath(process.env.HOST_BACKUP_PATH, '/mnt/backup')}/${SYSTEM_NAMESPACE}/etcd/config`;

  // Check if we have a saved cluster config (from a previous join)
  const clusterConfig = readClusterConfig();

  let cmd;
  let portBindings = {};
  let clusterToken;
  let keepalivedPass;

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

    clusterToken = crypto.randomBytes(16).toString('hex');
    keepalivedPass = process.env.KEEPALIVED_PASSWORD || crypto.randomBytes(16).toString('hex');

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
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64M' },
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
      const rootPass = crypto.randomBytes(32).toString('hex');

      // Wait for etcd to be ready before running auth commands.
      // Docker exec hangs if the target command doesn't exit, so all
      // exec calls use execWithTimeout to ensure forward progress.
      for (let i = 0; i < 30; i++) {
        try {
          const ready = await execWithTimeout(newContainer, ['etcdctl', 'endpoint', 'health'], 5000);
          if (ready) break;
        } catch (e) {}
        await new Promise(r => setTimeout(r, 1000));
      }
      console.log('[ETCD] Ready, setting up authentication...');

      for (let i = 0; i < 10; i++) {
        try {
          // Attempt to add root user — fails harmlessly if already exists
          await execWithTimeout(newContainer, ['etcdctl', 'user', 'add', `root:${rootPass}`]);
        } catch (e) {
          // Timeout — etcd might not be ready yet
          console.log(`[ETCD] Waiting for etcd readiness (auth setup)... ${e.message}`);
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        // Enable authentication (idempotent — safe to call even if user already exists)
        try {
          await execWithTimeout(newContainer, ['etcdctl', 'auth', 'enable']);
        } catch (e) {
          console.log(`[ETCD] Waiting for etcd readiness (auth enable)... ${e.message}`);
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        // Save credentials
        const authPath = `${BACKUP_MOUNT}/${SYSTEM_NAMESPACE}/etcd/auth.json`;
        const dir = path.dirname(authPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(authPath, JSON.stringify({ username: 'root', password: rootPass }, null, 2));
        console.log('[ETCD] Authentication enabled.');
        break;
      }
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
  const authArgs = getAuthArgs();
  const container = docker.getContainer(CONTAINER_NAME);

  console.log(`[ETCD] Adding member ${nodeName} with peer URL http://${nodeIp}:2380`);

  // Run etcdctl member add with timeout + retry with backoff.
  // Uses --endpoints=127.0.0.1:2379 explicitly to avoid ambiguity.
  // Retries are essential: a previous partially-completed join attempt may
  // have left etcd briefly unresponsive, and the retry gives it time to recover.
  const memberAddCmd = [
    'etcdctl',
    '--endpoints=127.0.0.1:2379',
    '--command-timeout=60s',
    ...authArgs,
    'member', 'add', nodeName,
    '--peer-urls', `http://${nodeIp}:2380`,
  ];

  const EXISTS_SENTINEL = '__MEMBER_EXISTS__';
  let memberAddOutput = null;
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const delay = attempt * 2000;
      console.log(`[ETCD] Retrying member add (attempt ${attempt + 1}/3, waiting ${delay}ms)...`);
      await new Promise(r => setTimeout(r, delay));
    }

    try {
      const { success, output } = await execWithOutput(container, memberAddCmd, 90000);
      if (success) {
        memberAddOutput = output;
        console.log(`[ETCD] Member add succeeded on attempt ${attempt + 1}:`, output);
        break;
      }

      // Check if member already exists (from a previous partially-completed join)
      if (output.includes('already exists') || output.includes('etcdserver: member ID')) {
        console.log(`[ETCD] Member ${nodeName} already exists, treating as success.`);
        memberAddOutput = EXISTS_SENTINEL;
        break;
      }

      // Strip gRPC binary framing from error output for readability
      const cleanOutput = output.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
      lastError = new Error(`etcdctl member add failed: ${cleanOutput}`);
      console.warn(`[ETCD] Member add attempt ${attempt + 1} returned non-zero: ${cleanOutput}`);
    } catch (e) {
      lastError = e;
      console.warn(`[ETCD] Member add attempt ${attempt + 1} error: ${e.message}`);
    }
  }

  // If all attempts failed and we don't have an "already exists" result, throw
  if (memberAddOutput === null && lastError) {
    throw lastError;
  }

  // Parse member add output (may be sentinel if member was pre-existing)
  const parsed = (memberAddOutput && memberAddOutput !== EXISTS_SENTINEL)
    ? parseEtcdctlAddOutput(memberAddOutput)
    : {};

  // Get the full member list to build client URLs (with retry)
  const memberListCmd = [
    'etcdctl',
    '--endpoints=127.0.0.1:2379',
    ...authArgs,
    'member', 'list', '--write-out=json',
  ];

  let allClientUrls = [];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { success, output } = await execWithOutput(container, memberListCmd, 15000);
      if (success && output) {
        try {
          const memberList = JSON.parse(output);
          if (memberList.members) {
            allClientUrls = memberList.members.map(m => {
              const url = m.clientURLs && m.clientURLs[0];
              return url || null;
            }).filter(Boolean);
          }
          console.log(`[ETCD] Member list: ${allClientUrls.join(', ')}`);
          break;
        } catch (e) {
          console.warn(`[ETCD] Failed to parse member list JSON: ${e.message}`);
        }
      }
    } catch (e) {
      console.warn(`[ETCD] Member list attempt ${attempt + 1} error: ${e.message}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    }
  }

  if (allClientUrls.length === 0) {
    console.warn('[ETCD] Could not retrieve member list — cluster join may be incomplete.');
  }

  const clusterConfig = readClusterConfig();

  // Read etcd auth credentials to share with joining nodes
  let authCreds;
  try {
    const authFile = path.join(BACKUP_MOUNT, `${SYSTEM_NAMESPACE}/etcd/auth.json`);
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
    keepalivedPassword: clusterConfig ? clusterConfig.keepalivedPassword : undefined,
  };
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
  const dataDir = path.join(BACKUP_MOUNT, `${SYSTEM_NAMESPACE}/etcd-data`);
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
  const configPath = `${resolveHostPath(process.env.HOST_BACKUP_PATH, '/mnt/backup')}/${SYSTEM_NAMESPACE}/etcd/config`;

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
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64M' },
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
    keepalivedPassword: clusterInfo.keepalivedPassword,
  });

  console.log(`[ETCD] Migration complete. Cluster members: ${memberIps.map(m => m.name).join(', ')}`);
  return true;
};
