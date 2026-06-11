import { etcd, getContainers, getGroups, getNodes, saveContainer } from './db.js';
import { withContainerLock } from '../utils/locks.js';

const ORCHESTRATOR_LOCK_KEY = 'leader/orchestrator';

export const runOrchestrationLoop = async () => {
  console.log('[Orchestrator] Running HA scheduling evaluation...');
  try {
    const nodes = await getNodes();
    const aliveNodeIds = nodes.map(n => n.id);
    const containers = await getContainers();
    const groups = await getGroups();

    // Build maps of group name → HA config for quick lookup
    const haGroupNames = new Set(groups.filter(g => g.config?.highAvailability).map(g => g.name));
    const haGroupAllowedNodes = new Map(
      groups.filter(g => g.config?.highAvailability && g.config?.ha_allowed_nodes?.length > 0)
        .map(g => [g.name, g.config.ha_allowed_nodes])
    );

    for (const container of containers) {
      const isHA = container.config?.ha || (container.config?.group && haGroupNames.has(container.config.group));
      if (isHA && container.status === 'running') {
        const isOrphaned = !aliveNodeIds.includes(container.current_node);

        if (isOrphaned) {
          console.log(`[Orchestrator] Container ${container.name} is orphaned (Host ${container.current_node} died). Rescheduling...`);

          // 1. Filter allowed nodes (individual first, then group-level)
          let candidates = nodes.filter(n => {
            const containerAllowed = container.config.ha_allowed_nodes;
            const groupAllowed = container.config.group ? haGroupAllowedNodes.get(container.config.group) : null;
            // Use container-level allowlist if set, otherwise group-level, otherwise all nodes
            if (containerAllowed && containerAllowed.length > 0) {
              return containerAllowed.includes(n.id);
            }
            if (groupAllowed && groupAllowed.length > 0) {
              return groupAllowed.includes(n.id);
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
            
            const memA = countA.reduce((sum, c) => sum + ((c.config?.resources?.memory || 512) * 1024 * 1024), 0);
            const memB = countB.reduce((sum, c) => sum + ((c.config?.resources?.memory || 512) * 1024 * 1024), 0);

            const cpuA = countA.reduce((sum, c) => sum + (c.config?.resources?.cpu || 1), 0);
            const cpuB = countB.reduce((sum, c) => sum + (c.config?.resources?.cpu || 1), 0);
            
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

          // 3. Update assignment under distributed lock to prevent
          // concurrent reassignment during leadership transitions.
          await withContainerLock(container.id, async () => {
            const updatedContainer = { ...container, current_node: targetNode.id };
            await saveContainer(updatedContainer.id, updatedContainer.name, updatedContainer.config, updatedContainer.status, null, targetNode.id);

            // 4. Update DNS for CoreDNS (etcd plugin)
            if (container.config.proxy?.domain) {
              const dnsKey = `skydns/local/home/${container.name}`;
              const dnsIp = targetNode.clientIp || targetNode.ip;
              await etcd.put(dnsKey).value(JSON.stringify({ host: dnsIp }));
              console.log(`[Orchestrator] Updated DNS: ${container.config.proxy.domain} -> ${dnsIp}`);
            }
          });
        }
      }
    }
  } catch (e) {
    console.error('[Orchestrator] HA loop error:', e.message);
  }
};

let orchestratorInterval = null;
let activeCampaign = null;

export const stopOrchestrator = () => {
  if (orchestratorInterval) {
    clearInterval(orchestratorInterval);
    orchestratorInterval = null;
    console.log('[Orchestrator] Stopped.');
  }
  if (activeCampaign) {
    try { activeCampaign.cancel(); } catch (e) { /* ignore */ }
    activeCampaign = null;
  }
};

export const startOrchestrator = (localNodeId) => {
  // Guard against duplicate campaigns (e.g. re-entry from error handler)
  if (activeCampaign) {
    console.log('[Orchestrator] Campaign already active, skipping duplicate start.');
    return;
  }
  console.log(`[Orchestrator] Initializing on Node ${localNodeId}...`);

  const election = etcd.election(ORCHESTRATOR_LOCK_KEY);
  const campaign = election.campaign(localNodeId);
  activeCampaign = campaign;
  
  campaign.on('elected', () => {
    console.log('★ [Orchestrator] This node is now the Cluster Leader!');
    orchestratorInterval = setInterval(() => {
      (async () => {
        try {
          await runOrchestrationLoop();
        } catch (err) {
          console.error('[Orchestrator] Loop error:', err.message);
        }
      })();
    }, 5000);
  });

  campaign.on('error', (err) => {
    console.error('[Orchestrator] Election error:', err.message);
    // Stop the orchestration loop — when the lease expires or connection drops,
    // this node is no longer the leader and must stop modifying containers.
    stopOrchestrator();
    // Re-enter the campaign after a backoff period
    setTimeout(() => startOrchestrator(localNodeId), 10000);
  });
};
