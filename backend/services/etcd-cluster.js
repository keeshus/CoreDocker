import docker from './docker.js';
import { SYSTEM_NAMESPACE, resolveHostPath } from './ephemeral-tasks.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';

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
      // Docker's multiplexed stream uses 8-byte frame headers per chunk.
      // Demux into separate stdout/stderr streams to get clean output.
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let stdoutData = '';
      let stderrData = '';
      stdout.on('data', c => stdoutData += c.toString());
      stderr.on('data', c => stderrData += c.toString());
      container.modem.demuxStream(stream, stdout, stderr);
      stream.on('end', async () => {
        clearTimeout(timer);
        try {
          const insp = await exec.inspect();
          resolve({ success: insp.ExitCode === 0, output: stdoutData, stderr: stderrData });
        } catch (inspectErr) {
          resolve({ success: false, output: stdoutData, stderr: stderrData });
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
    // IMPORTANT: etcdctl endpoint health returns exit code 0 even when the
    // response says "unhealthy" — we must check the output content too.
    const authArgs = getAuthArgs();
    const healthCmd = ['etcdctl', ...authArgs, 'endpoint', 'health'];
    let healthy = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await execWithOutput(container, healthCmd, 10000);
        healthy = result.success && result.output.includes('is healthy');
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
    // Use --initial-cluster-state=new when the data directory is empty (first boot)
    // and 'existing' when there's a WAL (subsequent restarts)
    const dataDir = getEtcdDataHostPath();
    const hasWAL = fs.existsSync(path.join(dataDir, 'member', 'wal'));
    const clusterState = hasWAL ? 'existing' : 'new';

    console.log(`[ETCD] Found cluster config, starting as clustered member (state=${clusterState}).`);
    const members = clusterConfig.members || [];
    // When starting with a fresh data directory (state=new), only include the
// local member in --initial-cluster. Stale peers from a previous join would
// prevent quorum since they're not actually running. They'll be re-added
// dynamically when they rejoin.
let activeMembers;
if (clusterState === 'new') {
  const localMembers = members.filter(m => m.name === etcdName);
  activeMembers = localMembers.length > 0
    ? localMembers
    : [{ name: etcdName, ip: advertiseIp || '127.0.0.1' }];
} else {
  activeMembers = members;
}
const initialCluster = activeMembers.map(m => `${m.name}=http://${m.ip}:2380`).join(',');
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
      '--initial-cluster-state', clusterState,
      '--initial-cluster-token', clusterConfig.clusterToken || 'core-docker-cluster',
      '--max-learners', '5',
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

    clusterToken = 'core-docker-cluster';  // fixed token so restarts match
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
      '--max-learners', '5',
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

    // Wipe stale Raft data when starting standalone (no cluster config).
    // A partial join from a previous lifecycle may have left members in the
    // WAL that will block quorum. This is ONLY done when there's NO cluster
    // config — meaning the node was never successfully part of a real cluster.
    // Nodes with a cluster config take the clustered path above and keep data.
    const d = getEtcdDataHostPath();
    try { if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); } catch (e) {
      console.warn(`[ETCD] Failed to wipe stale data: ${e.message}`);
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

    // Wait for etcd to be ready before any commands
    for (let i = 0; i < 30; i++) {
      try {
        const ready = await execWithTimeout(newContainer, ['etcdctl', 'endpoint', 'health'], 5000);
        if (ready) break;
      } catch (e) {}
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log('[ETCD] Ready, configuring authentication...');

    // Run auth setup on EVERY new container — not just on first bootstrap.
    // The health check wipe path recreates the container but would skip auth
    // if clusterConfig already exists, leaving the server without auth while
    // auth.json is still on disk.
    const rootPass = crypto.randomBytes(32).toString('hex');
    for (let i = 0; i < 20; i++) {
      try {
        // Check if auth is already enabled — if so, skip setup
        const status = await execWithOutput(newContainer, ['etcdctl', 'auth', 'status'], 5000);
        if (status.output.includes('Authentication enabled')) {
          console.log('[ETCD] Auth already enabled, reusing existing config.');
          break;
        }
      } catch {}

      try {
        // Attempt to add root user — fails harmlessly if already exists
        await execWithTimeout(newContainer, ['etcdctl', 'user', 'add', `root:${rootPass}`]);
      } catch (e) {
        console.log(`[ETCD] Waiting for auth readiness (user add)... ${e.message}`);
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      try {
        await execWithTimeout(newContainer, ['etcdctl', 'auth', 'enable']);
      } catch (e) {
        console.log(`[ETCD] Waiting for auth readiness (auth enable)... ${e.message}`);
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

    // Write cluster config so subsequent boots use the clustered path (always-cluster-mode)
    writeClusterConfig({
      clusterToken,
      members: [{ name: etcdName, ip: advertiseIp || "127.0.0.1" }],
      keepalivedPassword: keepalivedPass,
    });
    return true;
  } catch (err) {
    console.error('[ETCD] Failed to create container:', err.message);
    return false;
  }
};

/**
 * Find an etcd member ID (as hex string) by peer URL, or null if not found.
 * Uses the simple text output format to avoid JavaScript uint64 precision loss
 * that occurs when parsing JSON numbers. Returns the hex ID which etcdctl
 * member remove accepts directly.
 */
async function findMemberByPeerUrl(container, authArgs, peerUrl) {
  const listCmd = [
    'etcdctl', '--endpoints=127.0.0.1:2379', '--command-timeout=15s',
    ...authArgs, 'member', 'list',
  ];
  try {
    const { success, output } = await execWithOutput(container, listCmd, 20000);
    if (success && output) {
      // Output format per line: <hex-id>, <status>, <name>, <peer-url>, <client-url>, <is-learner>
      for (const line of output.trim().split('\n')) {
        const cols = line.split(', ');
        if (cols.length >= 4 && cols[3] === peerUrl) {
          return cols[0]; // Hex ID as string — safe for member remove
        }
      }
    }
  } catch (e) {
    console.warn(`[ETCD] Could not list members: ${e.message}`);
  }
  return null;
}

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

  const peerUrl = `http://${nodeIp}:2380`;
  console.log(`[ETCD] Adding learner member ${nodeName} with peer URL ${peerUrl}`);

  // Check if a member with this peer URL already exists (stale from a previous
  // failed join). If so, remove it first so re-joining is idempotent.
  const existingId = await findMemberByPeerUrl(container, authArgs, peerUrl);
  if (existingId) {
    console.log(`[ETCD] Stale member with peer URL ${peerUrl} found (ID: ${existingId}), removing...`);
    const removeCmd = [
      'etcdctl', '--endpoints=127.0.0.1:2379', '--command-timeout=30s',
      ...authArgs, 'member', 'remove', String(existingId),
    ];
    const { success: removed } = await execWithOutput(container, removeCmd, 60000);
    if (removed) {
      console.log(`[ETCD] Stale member removed.`);
    } else {
      console.warn(`[ETCD] Failed to remove stale member, attempting add anyway...`);
    }
  }

  // Single etcdctl call with generous timeout — runs inside the etcd container
  // via docker exec, bypassing the etcd3 client's circuit breaker.
  // Using --learner so the new member doesn't count toward Raft quorum until
  // explicitly promoted — this prevents the cluster from deadlocking while
  // the joining node starts its etcd in cluster mode.
  const memberAddCmd = [
    'etcdctl',
    '--endpoints=127.0.0.1:2379',
    '--command-timeout=60s',
    ...authArgs,
    'member', 'add', nodeName,
    '--learner',
    '--peer-urls', `http://${nodeIp}:2380`,
  ];

  const { success, output, stderr } = await execWithOutput(container, memberAddCmd, 120000);

  if (!success) {
    const cleanOutput = (output + '\n' + (stderr || '')).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
    throw new Error(`etcdctl member add failed: ${cleanOutput.trim()}`);
  }

  console.log(`[ETCD] Learner member added: ${nodeName}`);

  // Get member list to build client URLs
  const memberListCmd = [
    'etcdctl',
    '--endpoints=127.0.0.1:2379',
    ...authArgs,
    'member', 'list', '--write-out=json',
  ];

  let allClientUrls = [];
  let allMembers = [];
  try {
    const { success: listSuccess, output: listOutput } = await execWithOutput(container, memberListCmd, 30000);
    if (listSuccess && listOutput) {
      const memberList = JSON.parse(listOutput);
      if (memberList.members) {
        allMembers = memberList.members;
        allClientUrls = allMembers.map(m => {
          const url = m.clientURLs && m.clientURLs[0];
          return url || null;
        }).filter(Boolean);
      }
    }
  } catch (e) {
    console.warn(`[ETCD] Member list error: ${e.message}`);
  }

  if (allClientUrls.length === 0) {
    console.warn("[ETCD] Could not retrieve member list — cluster join may be incomplete.");
  }

  // Update local cluster config with the new member for consistent restarts
  // Build the initialCluster string from all members' peer URLs.
  // This is what the joining node passes as --initial-cluster to its etcd.
  // IMPORTANT: After `member add --learner`, the member list may have an empty
  // name for the learner (it's populated only after the member actually starts).
  // Use the known nodeName as a fallback for the member matching our peer URL.
  const joiningPeerUrl = `http://${nodeIp}:2380`;
  const initialCluster = allMembers.length > 0
    ? allMembers
        .filter(m => m.peerURLs?.[0])
        .map(m => {
          const name = m.name || (m.peerURLs?.[0] === joiningPeerUrl ? nodeName : null);
          return name ? `${name}=${m.peerURLs[0]}` : null;
        })
        .filter(Boolean)
        .join(',') || null
    : null;

  if (allMembers.length > 0) {
    const cc = readClusterConfig();
    writeClusterConfig({
      clusterToken: cc?.clusterToken || 'core-docker-cluster',
      members: allMembers.map(m => ({
        name: m.name || (m.peerURLs?.[0] === joiningPeerUrl ? nodeName : `member-${m.ID}`),
        ip: (m.peerURLs?.[0] || '').replace(/^http:\/\//, '').replace(/:2380$/, '') || nodeIp,
      })),
      keepalivedPassword: cc?.keepalivedPassword,
    });
  }

  const clusterConfig = readClusterConfig();

  // Read etcd auth credentials to share with joining nodes
  let authCreds;
  try {
    const authFile = path.join(BACKUP_MOUNT, `${SYSTEM_NAMESPACE}/etcd/auth.json`);
    if (fs.existsSync(authFile)) {
      authCreds = JSON.parse(fs.readFileSync(authFile, "utf8"));
    }
  } catch (e) {
    console.warn(`[ETCD] Failed to read auth credentials: ${e.message}`);
  }

  return {
    memberName: nodeName,
    initialCluster,
    initialClusterState: "existing",
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
    '--max-learners', '5',
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

/**
 * Promote a learner member to a full voting member.
 * Should be called AFTER the learner's etcd has started in cluster mode and
 * caught up with the Raft log. The promote will fail (and should be retried)
 * if the learner hasn't finished syncing yet.
 *
 * @param {string} memberName - Name of the learner to promote
 * @returns {Promise<boolean>}
 */
export const promoteEtcdMember = async (memberName) => {
  const authArgs = getAuthArgs();
  const container = docker.getContainer(CONTAINER_NAME);

  // Get member info using the simple text format which uses hex IDs.
  // JSON format loses precision for uint64 member IDs in JavaScript.
  // Text format per line: <hex-id>, <status>, <name>, <peer-url>, <client-url>, <is-learner>
  let memberHexId = null;
  let isLearner = false;

  for (let attempt = 0; attempt < 15; attempt++) {
    const listCmd = [
      'etcdctl', '--endpoints=127.0.0.1:2379', '--command-timeout=15s',
      ...authArgs, 'member', 'list',
    ];
    const { success, output } = await execWithOutput(container, listCmd, 20000);
    if (success && output) {
      for (const line of output.trim().split('\n')) {
        const cols = line.split(', ');
        if (cols.length >= 6 && cols[2] === memberName) {
          memberHexId = cols[0];
          isLearner = cols[5] === 'true';
          if (cols[4] && cols[4] !== '<none>' && cols[4].startsWith('http')) {
            // Learner has connected — ready to promote
            console.log(`[ETCD] Learner ${memberName} connected (clientURLs: ${cols[4]}), ready to promote.`);
            attempt = 99;
            break;
          }
          console.log(`[ETCD] Learner ${memberName} not yet connected (attempt ${attempt + 1}), waiting...`);
        }
      }
    }
    if (attempt === 99) break;
    await new Promise(r => setTimeout(r, 2000));
  }

  if (!memberHexId) {
    throw new Error(`Member "${memberName}" not found in cluster`);
  }

  if (!isLearner) {
    console.log(`[ETCD] ${memberName} is already a voting member, skipping promote.`);
    return true;
  }

  console.log(`[ETCD] Promoting learner ${memberName} (${memberHexId}) to voting member...`);
  const promoteCmd = [
    'etcdctl', '--endpoints=127.0.0.1:2379', '--command-timeout=30s',
    ...authArgs, 'member', 'promote', memberHexId,
  ];

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const result = await execWithOutput(container, promoteCmd, 30000);
      if (result.success) {
        console.log(`[ETCD] ${memberName} promoted to voting member.`);
        return true;
      }

      // Failed — learner may not have caught up yet
      const cleanErr = (result.output + '\n' + (result.stderr || '')).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();
      if (cleanErr.includes('too slow to catch up') || cleanErr.includes('not ready')) {
        console.log(`[ETCD] Learner ${memberName} not yet caught up (attempt ${attempt + 1}), retrying in 3s...`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      console.warn(`[ETCD] Promote attempt ${attempt + 1} failed: ${cleanErr}`);
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      console.warn(`[ETCD] Promote attempt ${attempt + 1} error: ${e.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  throw new Error(`Failed to promote learner ${memberName} after 10 attempts`);
};
