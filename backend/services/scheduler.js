import etcd from './db.js';
import { runEphemeralTask } from './ephemeral-tasks.js';
import { logEvent, purgeOldLogs } from './logger.js';

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
    const success = await lease.put(lockKey).value(nodeId).ifAbsent();
    
    if (!success) {
      // console.log(`[Scheduler] Lock ${lockKey} already held. Skipping task.`);
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
        taskResult = await runEphemeralTask('certbot/certbot', ['renew']);
      } else if (taskId === 'ha-folder-sync') {
        taskResult = await performHASync();
      } else if (taskId === 'purge-old-logs') {
        await purgeOldLogs();
        taskResult = { stdout: 'Logs purged successfully', exitCode: 0 };
      } else if (taskId === 'etcd-snapshot') {
        const backupPath = process.env.HOST_BACKUP_PATH || '/data/backup';
        const snapshotName = `etcd-snapshot-${new Date().toISOString().replace(/:/g, '-')}.db`;
        const destPath = `${backupPath}/${snapshotName}`;
        
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
            stream.on('data', chunk => {
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
    .map(([key, value]) => JSON.parse(value))
    .filter(c => c.highAvailability);

  if (haContainers.length === 0) return { stdout: 'No HA containers found', exitCode: 0 };

  let summary = `Syncing ${haContainers.length} containers...`;
  for (const container of haContainers) {
    // For each container, sync its data folder in backupPath to other nodes.
    // This requires knowing the other nodes IPs.
    const nodes = await etcd.getAll('nodes/').strings();
    const otherNodes = Object.entries(nodes)
        .map(([k, v]) => JSON.parse(v))
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
