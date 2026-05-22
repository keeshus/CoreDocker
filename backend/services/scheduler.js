import etcd from './db.js';
import { runEphemeralTask, SYSTEM_NAMESPACE } from './ephemeral-tasks.js';
import { logEvent, purgeOldLogs } from './logger.js';
import { getSecret } from './secrets.js';
import fs from 'fs';
import path from 'path';

const TASKS_PREFIX = 'tasks/';
const LOCKS_PREFIX = 'locks/';
const nodeId = process.env.NODE_ID || 'node-1';

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
  
  try {
    // Try to acquire lock with 10s TTL
    const lease = etcd.lease(10);
    const success = await etcd.put(lockKey).value(nodeId).lease(lease).ifAbsent();

    if (!success) {
      await lease.revoke();
      return;
    }

    try {
      await callback();
    } finally {
      await lease.revoke();
    }
  } catch (e) {
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
      nextRun: new Date(Date.now() + defaultTask.intervalMs).toISOString()
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

export const runTask = async (taskId) => {
  const task = await getTask(taskId);
  if (!task || !task.enabled || task.status === 'running') return;

  // Check if it's time to run
  if (task.nextRun && new Date(task.nextRun) > new Date()) return;

  await withLock(taskId, task.scope, async () => {
    logEvent('scheduler', 'info', `Starting task: ${task.name}`);
    await updateTask(taskId, { status: 'running' });

    try {
      let taskResult;
      if (taskId === 'restic-backup') {
        taskResult = await runEphemeralTask('restic/restic', ['backup', '/data/backup']);
      } else if (taskId === 'certbot-renew') {
        taskResult = await runCertbotRenew();
      } else if (taskId === 'ha-folder-sync') {
        taskResult = await performHASync();
      } else if (taskId === 'purge-old-logs') {
        await purgeOldLogs();
        taskResult = { stdout: 'Logs purged successfully', exitCode: 0 };
      } else if (taskId === 'etcd-snapshot') {
        const backupPath = process.env.HOST_BACKUP_PATH || '/data/backup';
        const snapshotName = `etcd-snapshot-${new Date().toISOString().replace(/:/g, '-')}.db`;
        const destPath = `${backupPath}/${SYSTEM_NAMESPACE}/${snapshotName}`;
        
        const docker = (await import('./docker.js')).default;
        const etcdContainer = docker.getContainer('core-docker-etcd');
        const exec = await etcdContainer.exec({
          Cmd: ['sh', '-c', `etcdctl snapshot save /tmp/${snapshotName} && cat /tmp/${snapshotName}`],
          AttachStdout: true,
          AttachStderr: true
        });
        
        taskResult = await new Promise((resolve, reject) => {
          exec.start(async (err, stream) => {
            if (err) return reject(err);
            
            const fs = await import('fs');
            if (!fs.existsSync(backupPath)) {
              fs.mkdirSync(backupPath, { recursive: true });
            }
            
            const writeStream = fs.createWriteStream(destPath);
            stream.on('data', () => {
              // Docker multiplexed stream: ignore headers if not using docker-modem demux, but since it's an exec stream we should be careful.
                // A better way is using runEphemeralTask but ETCD requires connecting to the live ETCD container.
            });
            
            docker.modem.demuxStream(stream, writeStream, process.stderr);
            
            stream.on('end', async () => {
              const inspectData = await exec.inspect();
              if (inspectData.ExitCode === 0) {
                resolve({ stdout: `Snapshot saved to ${destPath}`, exitCode: 0 });
              } else {
                resolve({ stdout: `Failed to save snapshot`, exitCode: inspectData.ExitCode });
              }
            });
          });
        });
        
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
        nextRun: new Date(Date.now() + task.intervalMs).toISOString()
      });
    } catch (err) {
      logEvent('scheduler', 'error', `Task failed: ${task.name}`, { error: err.message });
      await updateTask(taskId, { 
        status: 'failed', 
        lastRun: new Date().toISOString(),
        nextRun: new Date(Date.now() + task.intervalMs).toISOString()
      });
    }
  });
};

async function performHASync() {
  // 1. Find all HA containers or groups
  const allContainers = await etcd.getAll('core/containers/').strings();
  const haContainers = Object.entries(allContainers)
    .map(([, value]) => JSON.parse(value))
    .filter(c => c.highAvailability);

  if (haContainers.length === 0) return { stdout: 'No HA containers found', exitCode: 0 };

  let summary = `Syncing ${haContainers.length} containers...`;
  for (const container of haContainers) {
    // For each container, sync its data folder in backupPath to other nodes.
    // This requires knowing the other nodes IPs.
    const nodes = await etcd.getAll('nodes/').strings();
    const otherNodes = Object.entries(nodes)
        .map(([, v]) => JSON.parse(v))
        .filter(n => n.id !== nodeId);

    for (const targetNode of otherNodes) {
        try {
            // Use rsync ephemeral container to sync /data/backup/containers/{id} to targetNode
            // We assume targetNode has an rsync daemon or we use SSH (more complex).
            // For now, let's just log that we are syncing.
            await runEphemeralTask('alpine', ['sh', '-c', `echo "Syncing ${container.name} to ${targetNode.name} (${targetNode.ip})..."`]);
        } catch (e) {
            summary += `\nFailed to sync ${container.name} to ${targetNode.name}: ${e.message}`;
        }
    }
  }

  return { stdout: summary, exitCode: 0 };
}

async function runCertbotRenew() {
  const backupPath = process.env.HOST_BACKUP_PATH || '/data/backup';
  const sslDir = path.join(backupPath, SYSTEM_NAMESPACE, 'nginx', 'ssl', 'host');
  const fullchainPath = path.join(sslDir, 'fullchain.pem');
  const credsPath = path.join(backupPath, SYSTEM_NAMESPACE, 'cloudflare.creds');

  // Read Cloudflare DNS-01 credentials from cluster secrets
  let domain, cfToken;
  try {
    domain = await getSecret('cert-domain');
    cfToken = await getSecret('cert-cloudflare-token');
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
  schedulerInterval = setInterval(async () => {
    for (const task of DEFAULT_TASKS) {
        await runTask(task.id);
    }
  }, 30 * 1000); // Check every 30 seconds
};
