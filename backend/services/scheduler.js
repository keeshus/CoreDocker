import { etcd } from './db.js';
import { runEphemeralTask, SYSTEM_NAMESPACE } from './ephemeral-tasks.js';
import { logEvent, purgeOldLogs } from './logger.js';
import { getSecret } from './secrets.js';
import fs from 'fs';
import path from 'path';

const TASKS_PREFIX = 'tasks/';
const LOCKS_PREFIX = 'locks/';
const SETTINGS_KEY = 'cluster/settings';
import { nodeId } from '../config.js';

// Default task configurations
const DEFAULT_TASKS = [
  {
    id: 'restic-backup',
    name: 'Restic System Backup',
    scheduleDesc: 'Daily at 02:00',
    intervalMs: 24 * 60 * 60 * 1000,
    enabled: false,
    scope: 'node'
  },
  {
    id: 'certbot-renew',
    name: 'Certbot SSL Renewal',
    scheduleDesc: 'Daily at 03:00',
    intervalMs: 24 * 60 * 60 * 1000,
    enabled: false,
    scope: 'node'
  },
  {
    id: 'ha-folder-sync',
    name: 'High Availability Folder Sync',
    scheduleDesc: 'Every 5 minutes',
    intervalMs: 5 * 60 * 1000,
    enabled: true,
    scope: 'node'
  },
  {
    id: 'purge-old-logs',
    name: 'System Log Purge',
    scheduleDesc: 'Daily',
    intervalMs: 24 * 60 * 60 * 1000,
    enabled: true,
    scope: 'cluster'
  },
  {
    id: 'etcd-snapshot',
    name: 'ETCD Database Snapshot',
    scheduleDesc: 'Daily at 01:00',
    intervalMs: 24 * 60 * 60 * 1000,
    enabled: true,
    scope: 'node'
  }
];

/**
 * Generic Distributed Lock wrapper using ETCD.
 */
async function withLock(taskName, scope, callback) {
  const lockKey = scope === 'node'
    ? `${LOCKS_PREFIX}${taskName}/${nodeId}`
    : `${LOCKS_PREFIX}${taskName}/global`;

  const lease = etcd.lease(120); // 120s TTL — long enough for backup tasks
  let acquired = false;
  try {
    // Atomic compare-and-swap: only create if key doesn't exist
    const result = await etcd.if(lockKey, 'Create', '==', 0)
      .then(lease.put(lockKey).value(nodeId))
      .commit();
    if (!result.succeeded) return; // Lock held by another node — skip silently
    acquired = true;

    try {
      await callback();
    } finally {
      if (acquired) await lease.revoke().catch(() => {});
    }
  } catch (e) {
    if (acquired) await lease.revoke().catch(() => {});
    console.error(`[Scheduler] Locking error for ${taskName}: ${e.message}`);
  }
}

// Helper to get or create task state
export const getTask = async (taskId) => {
  const taskStr = await etcd.get(`${TASKS_PREFIX}${taskId}`).string();
  if (taskStr) {
    return JSON.parse(taskStr);
  }
  
  const defaultTask = DEFAULT_TASKS.find(t => t.id === taskId);
  if (defaultTask) {
    const newTask = {
      ...defaultTask,
      status: 'idle',
      lastRun: null,
      nextRun: new Date(Date.now()).toISOString()
    };
    await etcd.put(`${TASKS_PREFIX}${taskId}`).value(JSON.stringify(newTask));
    return newTask;
  }
  return null;
};

export const getAllTasks = async () => {
  const tasks = [];
  for (const t of DEFAULT_TASKS) {
    tasks.push(await getTask(t.id));
  }
  return tasks;
};

export const updateTask = async (taskId, updates) => {
  const task = await getTask(taskId);
  if (task) {
    const updatedTask = { ...task, ...updates };
    await etcd.put(`${TASKS_PREFIX}${taskId}`).value(JSON.stringify(updatedTask));
    return updatedTask;
  }
  return null;
};

export const runTask = async (taskId, force = false) => {
  const task = await getTask(taskId);
  if (!task || !task.enabled || task.status === 'running') return;

  // Check if it's time to run (skip this check when force-triggered e.g. from API)
  if (!force && task.nextRun && new Date(task.nextRun) > new Date()) return;

  await withLock(taskId, task.scope, async () => {
    logEvent('scheduler', 'info', `Starting task: ${task.name}`);
    await updateTask(taskId, { status: 'running' });

    try {
      let taskResult;
      if (taskId === 'restic-backup') {
        const settingsStr = await etcd.get(SETTINGS_KEY).string();
        const settings = settingsStr ? JSON.parse(settingsStr) : {};
        const resticPassword = await getSecret('__system__/restic-password');
        const accessKey = await getSecret('__system__/restic-access-key');
        const secretKey = await getSecret('__system__/restic-secret-key');

        if (!settings.resticS3Endpoint || !settings.resticS3Bucket) {
          taskResult = { stdout: 'Restic S3 endpoint or bucket not configured. Set them in Cluster Settings.', exitCode: 0 };
        } else if (!resticPassword || !accessKey || !secretKey) {
          taskResult = { stdout: 'Restic credentials (password, access key, secret key) not configured. Set them in Cluster Settings.', exitCode: 0 };
        } else {
          const repo = `s3:https://${settings.resticS3Endpoint}/${settings.resticS3Bucket}`;
          const awsCredentialsFile = `[default]\naws_access_key_id = ${accessKey}\naws_secret_access_key = ${secretKey}\n`;

          const options = {
            Secrets: {
              'RESTIC_PASSWORD': resticPassword,
              'aws-credentials': awsCredentialsFile,
            },
            Env: [
              `RESTIC_REPOSITORY=${repo}`,
              `AWS_SHARED_CREDENTIALS_FILE=/run/secrets/aws-credentials`,
            ],
          };

          // Check if repo is initialized
          const checkResult = await runEphemeralTask('restic/restic', ['snapshots'], options);
          if (checkResult.exitCode !== 0) {
            logEvent('scheduler', 'info', 'Restic: Initializing new repository');
            const initResult = await runEphemeralTask('restic/restic', ['init'], options);
            if (initResult.exitCode !== 0) {
              throw new Error(`Restic init failed: ${initResult.stdout || 'no output'}`);
            }
          }

          const result = await runEphemeralTask('restic/restic', ['backup', '/data/backup'], options);
          taskResult = { stdout: truncateResticOutput(result.stdout || ''), exitCode: result.exitCode };
        }
      } else if (taskId === 'certbot-renew') {
        taskResult = await runCertbotRenew();
      } else if (taskId === 'ha-folder-sync') {
        taskResult = await performHASync();
      } else if (taskId === 'purge-old-logs') {
        await purgeOldLogs();
        taskResult = { stdout: 'Logs purged successfully', exitCode: 0 };
      } else if (taskId === 'etcd-snapshot') {
        const backupPath = '/mnt/backup';
        const snapshotName = `etcd-snapshot-${new Date().toISOString().replace(/:/g, '-')}.db`;
        const destPath = `${backupPath}/${SYSTEM_NAMESPACE}/${snapshotName}`;

        // Read etcd auth credentials
        let authUser = 'root';
        let authPass = '';
        try {
          const authData = JSON.parse(
            fs.readFileSync(`${backupPath}/${SYSTEM_NAMESPACE}/etcd/auth.json`, 'utf8')
          );
          authPass = authData.password || '';
        } catch {
          // Auth may not be enabled yet
        }

        const docker = (await import('./docker.js')).default;
        const etcdContainer = docker.getContainer('core-docker-etcd');

        // Write snapshot directly to the bind-mounted data dir on the shared volume,
        // so we don't need to stream binary data through Docker exec multiplexed streams.
        const snapshotFile = '/etcd-data/__snapshot_tmp.db';
        const exec = await etcdContainer.exec({
          Cmd: authPass
            ? ['etcdctl', 'snapshot', 'save', snapshotFile, '--user', `root:${authPass}`]
            : ['etcdctl', 'snapshot', 'save', snapshotFile],
          Env: ['ETCDCTL_API=3'],
          AttachStdout: true,
          AttachStderr: true
        });

        const { withTimeout } = await import('../utils/timeout.js');
        await withTimeout(
          new Promise((resolve, reject) => {
            exec.start((err, stream) => {
              if (err) { reject(err); return; }
              stream.on('end', resolve);
              stream.resume();
            });
          }),
          30000,
          'etcd snapshot save timed out'
        );

        const execInspect = await exec.inspect();
        if (execInspect.ExitCode !== 0) {
          throw new Error(`etcdctl snapshot save exited with code ${execInspect.ExitCode}`);
        }

        // Move snapshot from etcd data dir to final destination (same volume, instant mv)
        const tmpSnapshotOnVolume = `${backupPath}/${SYSTEM_NAMESPACE}/etcd-data/__snapshot_tmp.db`;
        if (fs.existsSync(tmpSnapshotOnVolume)) {
          fs.renameSync(tmpSnapshotOnVolume, destPath);
          taskResult = { stdout: `Snapshot saved to ${destPath}`, exitCode: 0 };
        } else {
          taskResult = { stdout: 'Snapshot file not found after save', exitCode: 1 };
        }

        // Keep only the 7 most recent snapshots
        const snapshotDir = `${backupPath}/${SYSTEM_NAMESPACE}`;
        try {
          const snapshots = fs.readdirSync(snapshotDir)
            .filter(f => f.startsWith('etcd-snapshot-') && f.endsWith('.db'))
            .map(f => ({ name: f, path: path.join(snapshotDir, f), mtime: fs.statSync(path.join(snapshotDir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);

          if (snapshots.length > 7) {
            for (const old of snapshots.slice(7)) {
              fs.unlinkSync(old.path);
            }
          }
        } catch (e) {
          console.warn(`[Scheduler] Failed to clean old snapshots: ${e.message}`);
        }
        
      } else {
        // Default simulated task
        await new Promise(resolve => setTimeout(resolve, 3000));
        taskResult = { stdout: 'Task completed successfully', exitCode: 0 };
      }

      logEvent('scheduler', taskResult.exitCode === 0 ? 'info' : 'error', `Completed task: ${task.name}`, { 
        stdout: taskResult.stdout,
        exitCode: taskResult.exitCode 
      });

      await updateTask(taskId, {
        status: taskResult.exitCode === 0 ? 'success' : 'failed',
        lastRun: new Date().toISOString(),
        nextRun: new Date(Date.now() + task.intervalMs).toISOString(),
        lastOutput: taskResult.stdout || '',
        lastExitCode: taskResult.exitCode,
        lastRunNode: nodeId
      });

      writeTaskLog(taskId, taskResult.exitCode, taskResult.stdout || '');
    } catch (err) {
      logEvent('scheduler', 'error', `Task failed: ${task.name}`, { error: err.message });
      await updateTask(taskId, {
        status: 'failed',
        lastRun: new Date().toISOString(),
        nextRun: new Date(Date.now() + task.intervalMs).toISOString(),
        lastOutput: `Error: ${err.message}`,
        lastExitCode: 1,
        lastRunNode: nodeId
      });

      writeTaskLog(taskId, 1, `Error: ${err.message}`);
    }
  });
};

function writeTaskLog(taskId, exitCode, output) {
  try {
    const logDir = `/mnt/non-backup/${SYSTEM_NAMESPACE}/tasks/${taskId}/${nodeId}`;
    fs.mkdirSync(logDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const logFile = path.join(logDir, `${timestamp}.log`);
    fs.writeFileSync(logFile, `Exit Code: ${exitCode}\n\n${output}`);
  } catch (e) {
    console.warn(`[Scheduler] Failed to write task log for ${taskId}: ${e.message}`);
  }
}

function truncateResticOutput(output) {
  // Restic progress lines contain \r (carriage return) — keep only the last 15 meaningful lines
  const lines = output.split(/\r?\n/).filter(Boolean);
  const cleaned = lines.map(l => l.replace(/\r.*$/, '')).filter(Boolean);
  const tail = cleaned.slice(-15);
  return tail.join('\n');
}

async function performHASync() {
  const settingsStr = await etcd.get(SETTINGS_KEY).string();
  const settings = settingsStr ? JSON.parse(settingsStr) : {};
  const sshUser = settings.sshUser || 'coredocker';
  const homeDir = `/home/${sshUser}`;

  // 1. Get all nodes
  const nodes = await etcd.getAll().prefix('nodes/').strings();
  const allNodes = Object.entries(nodes).map(([, v]) => JSON.parse(v));
  const otherNodes = allNodes.filter(n => n.id !== nodeId);

  if (otherNodes.length === 0) {
    return { stdout: 'Single node mode — no other nodes to sync to.', exitCode: 0 };
  }

  // 2. Ensure SSH keypair exists for this node
  const sshDir = `/mnt/backup/${SYSTEM_NAMESPACE}/ssh`;
  const privKeyPath = `${sshDir}/id_ed25519`;
  const pubKeyPath = `${sshDir}/id_ed25519.pub`;

  if (!fs.existsSync(privKeyPath)) {
    fs.mkdirSync(sshDir, { recursive: true });
    await runEphemeralTask('alpine', [
      'sh', '-c',
      `apk add --no-cache openssh-keygen >/dev/null 2>&1 && ssh-keygen -t ed25519 -f /data/backup/__system__/ssh/id_ed25519 -N ""`
    ]);
    logEvent('scheduler', 'info', `HA Sync: Generated SSH keypair for node ${nodeId}`);
  }

  // 3. Publish our public key to etcd
  let myPublicKey = '';
  try {
    myPublicKey = fs.readFileSync(pubKeyPath, 'utf8').trim();
    const nodeRecord = JSON.parse(await etcd.get(`nodes/${nodeId}`).string() || '{}');
    if (nodeRecord.publicKey !== myPublicKey) {
      nodeRecord.publicKey = myPublicKey;
      await etcd.put(`nodes/${nodeId}`).value(JSON.stringify(nodeRecord));
    }
  } catch (e) {
    return { stdout: `HA Sync: Failed to read/publish public key: ${e.message}`, exitCode: 1 };
  }

  // 4. Sync authorized_keys: each node authorizes all other nodes
  try {
    const docker = (await import('./docker.js')).default;
    const alpineImage = process.env.ALPINE_IMAGE || 'alpine:latest';

    // Build authorized_keys content from all other nodes' public keys
    const authorizedKeys = [];
    for (const other of otherNodes) {
      if (other.publicKey) {
        authorizedKeys.push(other.publicKey);
      }
    }

    if (authorizedKeys.length > 0) {
      const authKeysContent = authorizedKeys.join('\n') + '\n';

      // Write authorized_keys into the host SSH dir via an ephemeral container
      // that mounts the host's .ssh directory
      const result = await runEphemeralTask(alpineImage, [
        'sh', '-c',
        `mkdir -p /host-ssh && echo '${authKeysContent.replace(/'/g, "'\\''")}' > /host-ssh/authorized_keys`
      ], {
        HostConfig: {
          Binds: [`${homeDir}/.ssh:/host-ssh`],
        },
      });

      if (result.exitCode !== 0) {
        logEvent('scheduler', 'warn', `HA Sync: authorized_keys sync failed: ${result.stdout}`);
      } else {
        logEvent('scheduler', 'info', `HA Sync: Authorized ${authorizedKeys.length} public keys for ${otherNodes.length} peer nodes`);
      }
    }
  } catch (e) {
    logEvent('scheduler', 'warn', `HA Sync: authorized_keys setup failed: ${e.message}`);
  }

  // 5. Rsync HA containers to other nodes
  const allContainers = await etcd.getAll().prefix('core/containers/').strings();
  const haContainers = Object.entries(allContainers)
    .map(([, value]) => JSON.parse(value))
    .filter(c => c.config?.ha && c.current_node === nodeId);

  if (haContainers.length === 0) {
    return { stdout: `HA Sync: No HA containers assigned to this node. SSH keys configured for ${otherNodes.length} peer(s).`, exitCode: 0 };
  }

  const backupPath = '/mnt/backup';
  let synced = 0;
  let errors = [];

  for (const container of haContainers) {
    const containerDir = `${backupPath}/containers/${container.name}`;
    if (!fs.existsSync(containerDir)) {
      logEvent('scheduler', 'info', `HA Sync: No data directory for ${container.name}, skipping`);
      continue;
    }

    for (const target of otherNodes) {
      if (!target.ip) continue;
      try {
        const rsyncResult = await runEphemeralTask('alpine', [
          'sh', '-c',
          `apk add --no-cache openssh rsync >/dev/null 2>&1 && ` +
          `rsync -e "ssh -i /data/backup/__system__/ssh/id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" ` +
          `-avz --delete --update ${containerDir}/ ${sshUser}@${target.ip}:/data/backup/containers/${container.name}/`
        ]);
        if (rsyncResult.exitCode === 0) {
          synced++;
          logEvent('scheduler', 'info', `HA Sync: Synced ${container.name} to ${target.id} (${target.ip})`);
        } else {
          errors.push(`${container.name} -> ${target.id}: ${(rsyncResult.stdout || '').slice(-200)}`);
        }
      } catch (e) {
        errors.push(`${container.name} -> ${target.id}: ${e.message}`);
      }
    }
  }

  const summary = `HA Sync: Synced ${synced} container(s) to peer nodes. ${errors.length > 0 ? 'Errors: ' + errors.join('; ') : 'All successful.'}`;
  return { stdout: summary, exitCode: errors.length > 0 ? 1 : 0 };
}

async function runCertbotRenew() {
  const backupPath = '/mnt/backup';
  const nonBackupPath = '/mnt/non-backup';
  const sslDir = path.join(backupPath, SYSTEM_NAMESPACE, 'nginx', 'ssl', 'host');
  const fullchainPath = path.join(sslDir, 'fullchain.pem');
  const credsPath = path.join(nonBackupPath, SYSTEM_NAMESPACE, '.tmp-certbot-creds');

  // Read Cloudflare DNS-01 credentials from cluster secrets
  let domain, cfToken;
  try {
    domain = await getSecret('__system__/cert-domain');
    cfToken = await getSecret('__system__/cert-cloudflare-token');
  } catch (e) {
    return { stdout: `Failed to read cert secrets: ${e.message}`, exitCode: 1 };
  }

  if (!domain || !cfToken) {
    logEvent('scheduler', 'warn', 'Certbot: cert-domain or cert-cloudflare-token not configured. Skipping renewal.');
    return { stdout: 'Cloudflare credentials not configured. Set cert-domain and cert-cloudflare-token secrets.', exitCode: 0 };
  }

  // Write Cloudflare credentials file
  try {
    if (!fs.existsSync(path.dirname(credsPath))) fs.mkdirSync(path.dirname(credsPath), { recursive: true });
    fs.writeFileSync(credsPath, `dns_cloudflare_api_token = ${cfToken}\n`);
  } catch (e) {
    return { stdout: `Failed to write Cloudflare creds: ${e.message}`, exitCode: 1 };
  }

  // Determine if this is a first-time issue or renewal
  const isFirstRun = !fs.existsSync(fullchainPath);

  // Build certbot command
  const email = `admin@${domain.replace(/^\*\./, '')}`;
  const deployHook = `cp /etc/letsencrypt/live/core-docker/fullchain.pem /ssl/ && cp /etc/letsencrypt/live/core-docker/privkey.pem /ssl/`;

  let cmd;
  if (isFirstRun) {
    cmd = [
      'certbot', 'certonly', '--dns-cloudflare',
      '--dns-cloudflare-credentials', '/creds.ini',
      '--non-interactive', '--agree-tos',
      '--email', email,
      '-d', domain,
      '-d', `*.${domain.replace(/^\*\./, '')}`,
      '--cert-name', 'core-docker',
      '--deploy-hook', deployHook,
    ];
    logEvent('scheduler', 'info', `Certbot: Requesting first certificate for ${domain}`);
  } else {
    cmd = [
      'certbot', 'renew', '--dns-cloudflare',
      '--dns-cloudflare-credentials', '/creds.ini',
      '--non-interactive',
      '--cert-name', 'core-docker',
      '--deploy-hook', deployHook,
    ];
    logEvent('scheduler', 'info', 'Certbot: Running renewal check');
  }

  // Run certbot in an ephemeral container. The backup mount gives access to
  // cloudflare.creds (via /data/backup/__system__/) and the SSL output directory
  // (via /data/backup/__system__/nginx/ssl/host/ → mounted at /ssl/).
  try {
    const result = await runEphemeralTask('certbot/dns-cloudflare', cmd, {
      HostConfig: {
        Binds: [
          `${sslDir}:/ssl`,
          `${credsPath}:/creds.ini:ro`,
        ],
      },
    });

    if (result.exitCode === 0) {
      logEvent('scheduler', 'info', `Certbot: Certificate for ${domain} updated successfully`);

      // Reload nginx to pick up new certs
      try {
        const docker = (await import('./docker.js')).default;
        const containers = await docker.listContainers({ filters: { name: ['^/core-docker-proxy$'] } });
        if (containers.length > 0) {
          const nginxContainer = docker.getContainer(containers[0].Id);
          const exec = await nginxContainer.exec({
            Cmd: ['nginx', '-s', 'reload'],
            AttachStdout: true, AttachStderr: true,
          });
          await exec.start();
        }
      } catch (e) {
        logEvent('scheduler', 'warn', `Certbot: Failed to reload nginx: ${e.message}`);
      }

      return { stdout: `Certificate for ${domain} updated`, exitCode: 0 };
    }

    logEvent('scheduler', 'error', `Certbot: Command failed with exit code ${result.exitCode}`);
    return { stdout: `Certbot command failed: ${result.stdout || 'no output'}`, exitCode: result.exitCode };
  } catch (e) {
    logEvent('scheduler', 'error', `Certbot: Task failed: ${e.message}`);
    return { stdout: `Certbot task error: ${e.message}`, exitCode: 1 };
  } finally {
    // Clean up credentials file
    try { fs.unlinkSync(credsPath); } catch {}
  }
}

let schedulerInterval = null;

export const stopScheduler = () => {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[Scheduler] Stopped.');
  }
};

export const startScheduler = () => {
  if (schedulerInterval) return;
  console.log('[Scheduler] Started.');
  schedulerInterval = setInterval(() => {
    (async () => {
      try {
        for (const task of DEFAULT_TASKS) {
          await runTask(task.id);
        }
      } catch (err) {
        console.error('[Scheduler] Interval error:', err.message);
      }
    })();
  }, 30 * 1000); // Check every 30 seconds

  // Fire immediately on boot so tasks with enabled:true run right away,
  // not 30 seconds from now
  for (const task of DEFAULT_TASKS) {
    runTask(task.id).catch(err => console.error('[Scheduler] Boot task error:', err.message));
  }
};
