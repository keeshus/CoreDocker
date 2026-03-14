import etcd from './db.js';

const TASKS_PREFIX = 'tasks/';

// Default task configurations
const DEFAULT_TASKS = [
  {
    id: 'restic-backup',
    name: 'Restic System Backup',
    scheduleDesc: 'Daily at 02:00',
    intervalMs: 24 * 60 * 60 * 1000,
    enabled: false
  },
  {
    id: 'volume-sync',
    name: 'Volume Sync (HA)',
    scheduleDesc: 'Every 10 minutes',
    intervalMs: 10 * 60 * 1000,
    enabled: false
  },
  {
    id: 'certbot-renew',
    name: 'Certbot SSL Renewal',
    scheduleDesc: 'Daily at 03:00',
    intervalMs: 24 * 60 * 60 * 1000,
    enabled: false
  }
];

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
  if (!task || task.status === 'running') return;

  console.log(`[Scheduler] Starting task: ${task.name}`);
  await updateTask(taskId, { status: 'running' });

  try {
    // Simulated task execution
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    console.log(`[Scheduler] Completed task: ${task.name}`);
    await updateTask(taskId, { 
      status: 'success', 
      lastRun: new Date().toISOString(),
      nextRun: new Date(Date.now() + task.intervalMs).toISOString()
    });
  } catch (err) {
    console.error(`[Scheduler] Task failed: ${task.name}`, err);
    await updateTask(taskId, { 
      status: 'failed', 
      lastRun: new Date().toISOString(),
      nextRun: new Date(Date.now() + task.intervalMs).toISOString()
    });
  }
};

export const startScheduler = () => {
  console.log('[Scheduler] Started');
  setInterval(async () => {
    try {
      const tasks = await getAllTasks();
      for (const task of tasks) {
        if (!task.enabled) continue;
        
        if (task.nextRun && new Date(task.nextRun) <= new Date() && task.status !== 'running') {
          runTask(task.id);
        }
      }
    } catch (e) {
      console.error('[Scheduler] Error checking tasks', e);
    }
  }, 10000); // Check every 10 seconds
};
