import etcd from './db.js';
import { getContainers, getNodes, saveContainer } from './db.js';

const ORCHESTRATOR_LOCK_KEY = 'leader/orchestrator';

const runOrchestrationLoop = async () => {
  console.log('[Orchestrator] Running HA scheduling evaluation...');
  try {
    const nodes = await getNodes();
    const aliveNodeIds = nodes.map(n => n.id);
    const containers = await getContainers();

    for (const container of containers) {
      if (container.config?.ha && container.status === 'running') {
        const isOrphaned = !aliveNodeIds.includes(container.current_node);
        
        if (isOrphaned) {
          console.log(`[Orchestrator] Container ${container.name} is orphaned (Host ${container.current_node} died). Rescheduling...`);
          
          // 1. Filter allowed nodes
          let candidates = nodes.filter(n => {
            if (container.config.ha_allowed_nodes && container.config.ha_allowed_nodes.length > 0) {
              return container.config.ha_allowed_nodes.includes(n.id);
            }
            return true;
          });

          if (candidates.length === 0) {
            console.error(`[Orchestrator] No valid target nodes for HA container ${container.name}`);
            continue;
          }

          // 2. Select node with highest uncommitted resources
          candidates.sort((a, b) => {
            const countA = containers.filter(c => c.current_node === a.id);
            const countB = containers.filter(c => c.current_node === b.id);
            
            const memA = countA.reduce((sum, c) => sum + (c.config?.resources?.memoryLimit || 512 * 1024 * 1024), 0);
            const memB = countB.reduce((sum, c) => sum + (c.config?.resources?.memoryLimit || 512 * 1024 * 1024), 0);
            
            const cpuA = countA.reduce((sum, c) => sum + (c.config?.resources?.cpuLimit || 1), 0);
            const cpuB = countB.reduce((sum, c) => sum + (c.config?.resources?.cpuLimit || 1), 0);
            
            const freeMemA = (a.system?.totalMem || Number.MAX_SAFE_INTEGER) - memA;
            const freeMemB = (b.system?.totalMem || Number.MAX_SAFE_INTEGER) - memB;

            const freeCpuA = (a.system?.cpus || 4) - cpuA;
            const freeCpuB = (b.system?.cpus || 4) - cpuB;

            // Sort by CPU first, then Memory
            if (freeCpuA !== freeCpuB) {
              return freeCpuB - freeCpuA;
            }
            return freeMemB - freeMemA;
          });

          const targetNode = candidates[0];
          console.log(`[Orchestrator] Moving ${container.name} to Node ${targetNode.id} (${targetNode.ip})`);

          // 3. Update assignment
          const updatedContainer = { ...container, current_node: targetNode.id };
          await saveContainer(updatedContainer.id, updatedContainer.name, updatedContainer.config, updatedContainer.status, null, targetNode.id);
          
          // 4. Update DNS for CoreDNS (etcd plugin)
          if (container.config.proxy?.domain) {
            const dnsKey = `skydns/local/home/${container.name}`;
            await etcd.put(dnsKey).value(JSON.stringify({ host: targetNode.ip }));
            console.log(`[Orchestrator] Updated DNS: ${container.config.proxy.domain} -> ${targetNode.ip}`);
          }
        }
      }
    }
  } catch (e) {
    console.error('[Orchestrator] HA loop error:', e.message);
  }
};

let orchestratorInterval = null;

export const stopOrchestrator = () => {
  if (orchestratorInterval) {
    clearInterval(orchestratorInterval);
    orchestratorInterval = null;
    console.log('[Orchestrator] Stopped.');
  }
};

export const startOrchestrator = (localNodeId) => {
  console.log(`[Orchestrator] Initializing on Node ${localNodeId}...`);
  
  const election = etcd.election(ORCHESTRATOR_LOCK_KEY);
  const campaign = election.campaign(localNodeId);
  
  campaign.on('elected', () => {
    console.log('★ [Orchestrator] This node is now the Cluster Leader!');
    orchestratorInterval = setInterval(runOrchestrationLoop, 5000);
  });

  campaign.on('error', (err) => {
    console.error('[Orchestrator] Election error:', err.message);
  });
};
