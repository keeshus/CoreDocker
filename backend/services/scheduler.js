import etcd from './db.js';
import { getContainers, getNodes, saveContainer } from './db.js';

const TASKS_PREFIX = 'tasks/';
const SCHEDULER_LOCK_KEY = 'leader/scheduler';

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

const runSchedulingLoop = async () => {
  console.log('[Scheduler] Running HA scheduling evaluation...');
  try {
    const nodes = await getNodes();
    const aliveNodeIds = nodes.map(n => n.id);
    const containers = await getContainers();

    for (const container of containers) {
      if (container.config?.ha && container.status === 'running') {
        const isOrphaned = !aliveNodeIds.includes(container.current_node);
        
        if (isOrphaned) {
          console.log(`[Scheduler] Container ${container.name} is orphaned (Host ${container.current_node} died). Rescheduling...`);
          
          // 1. Filter allowed nodes
          let candidates = nodes.filter(n => {
            if (container.config.ha_allowed_nodes && container.config.ha_allowed_nodes.length > 0) {
              return container.config.ha_allowed_nodes.includes(n.id);
            }
            return true;
          });

          if (candidates.length === 0) {
            console.error(`[Scheduler] No valid target nodes for HA container ${container.name}`);
            continue;
          }

          // 2. Select node with most resources (simple heuristic: node with fewest containers for now)
          candidates.sort((a, b) => {
            const countA = containers.filter(c => c.current_node === a.id).length;
            const countB = containers.filter(c => c.current_node === b.id).length;
            return countA - countB;
          });

          const targetNode = candidates[0];
          console.log(`[Scheduler] Moving ${container.name} to Node ${targetNode.id} (${targetNode.ip})`);

          // 3. Update assignment
          const updatedContainer = { ...container, current_node: targetNode.id };
          await saveContainer(updatedContainer.id, updatedContainer.name, updatedContainer.config, updatedContainer.status, null);
          
          // 4. Update DNS
          if (container.config.proxy?.domain) {
            const dnsKey = `skydns/local/home/${container.name}`;
            await etcd.put(dnsKey).value(JSON.stringify({ host: targetNode.ip }));
            console.log(`[Scheduler] Updated DNS: ${container.config.proxy.domain} -> ${targetNode.ip}`);
          }
        }
      }
    }
  } catch (e) {
    console.error('[Scheduler] HA loop error:', e.message);
  }
};

export const startScheduler = (localNodeId) => {
  console.log(`[Scheduler] Initializing on Node ${localNodeId}...`);
  
  const election = etcd.election(SCHEDULER_LOCK_KEY);

  election.campaign(localNodeId).then(() => {
    console.log('★ [Scheduler] This node is now the Cluster Leader!');
    
    // Regular Task Scheduler
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
    }, 10000);

    // HA Workload Scheduler
    setInterval(runSchedulingLoop, 5000);
  });
};
