import crypto from 'crypto';
import docker from './docker.js';
import { etcd, getContainers, updateContainerDockerId, getNodes, getGroups } from './db.js';
import { addRoute } from './nginx.js';
import { resolveHostPath } from './ephemeral-tasks.js';
import { ensureContainerNetworks, ensureGroupNetwork } from './network-manager.js';
import { isNodeSealed } from './secrets.js';
import { buildCreateOpts } from '../utils/docker-opts.js';
import { runEphemeralTask } from './ephemeral-tasks.js';
import { promoteEtcdMember, addEtcdMember } from './etcd-cluster.js';
import fs from 'fs';
import path from 'path';

const SETTINGS_KEY = 'cluster/settings';
const ALPINE_IMAGE = process.env.ALPINE_IMAGE || 'alpine:latest';

const ensureImage = async (image) => {
  try {
    await docker.getImage(image).inspect();
  } catch (e) {
    console.log(`[Reconciler] Pulling image ${image}...`);
    await new Promise((resolve, reject) => {
      docker.pull(image, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err, res) => err ? reject(err) : resolve(res));
      });
    });
  }
};

const reconcileDNSVIP = async (localNodeId) => {
  try {
    const settingsStr = await etcd.get(SETTINGS_KEY).string().catch(() => null);
    if (!settingsStr) return;

    const settings = JSON.parse(settingsStr);

    if (!settings.dnsVip) return;

    let allNodes;
    try {
      allNodes = await getNodes();
    } catch (nodeErr) {
      console.warn(`[Reconciler] Failed to fetch nodes for DNS VIP: ${nodeErr.message}`);
      return;
    }

    const sortedNodes = allNodes.sort((a, b) => a.id.localeCompare(b.id));
    const nodeIndex = sortedNodes.findIndex(n => n.id === localNodeId);

    const containerName = 'core-docker-keepalived-dns';

    if (nodeIndex === -1 || nodeIndex >= 3) {
      try {
        const existing = docker.getContainer(containerName);
        await existing.stop();
        await existing.remove();
      } catch (e) {}
      return;
    }

    // Determine the VRRP interface:
    // 1. Use dnsVipInterface if explicitly set in settings
    // 2. Auto-detect by matching the node's IP to a host interface
    // 3. Fall back to 'eth0'
    const localNode = sortedNodes[nodeIndex];
    let vrrpInterface = settings.dnsVipInterface;
    if (!vrrpInterface && localNode) {
      vrrpInterface = await detectHostInterface(localNode.clientIp || localNode.ip);
    }
    if (!vrrpInterface) {
      vrrpInterface = 'eth0';
      console.log(`[Reconciler] Using default interface "eth0" for DNS VIP`);
    }

    const priority = 100 - (nodeIndex * 10);
    // Read keepalived password from etcd (auto-generated at bootstrap, propagated on join).
    // Env override for testing, otherwise etcd, otherwise warn and generate fallback.
    let keepalivedPass = process.env.KEEPALIVED_PASSWORD;
    if (!keepalivedPass) {
      try {
        keepalivedPass = await etcd.get('__system__/keepalived/password').string();
      } catch (e) {
        console.warn('[Reconciler] Could not read keepalived password from etcd:', e.message);
      }
    }
    if (!keepalivedPass) {
      keepalivedPass = crypto.randomBytes(16).toString('hex');
      console.warn('[Reconciler] Generated fallback keepalived password — cluster nodes may not match!');
    }
    const config = `
vrrp_instance VI_DNS {
    state ${nodeIndex === 0 ? 'MASTER' : 'BACKUP'}
    interface ${vrrpInterface}
    virtual_router_id 53
    priority ${priority}
    advert_int 1
    authentication {
        auth_type PASS
        auth_pass ${keepalivedPass}
    }
    virtual_ipaddress {
        ${settings.dnsVip}
    }
}
`;

    let container;
    try {
      container = docker.getContainer(containerName);
      await container.inspect();
    } catch (e) {
      if (e.statusCode === 404) {
        console.log('[Reconciler] Creating Keepalived DNS VIP container...');
        await ensureImage(ALPINE_IMAGE);
        container = await docker.createContainer({
          Image: ALPINE_IMAGE,
          name: containerName,
          Entrypoint: ['sh', '-c', 'apk add --no-cache keepalived && keepalived --dont-fork --log-console'],
          HostConfig: {
            CapAdd: ['NET_ADMIN', 'NET_BROADCAST'],
            NetworkMode: 'host',
            RestartPolicy: { Name: 'always' }
          }
        });
      }
    }

    if (!container) return;

    const inspect = await container.inspect();
    if (!inspect.State.Running) {
      await container.start();
    }

    // Write config via base64 to avoid shell injection through config values.
    // Drain the exec stream to prevent Docker daemon backpressure.
    const b64Config = Buffer.from(config).toString('base64');
    const exec = await container.exec({
      Cmd: ['sh', '-c', `echo ${b64Config} | base64 -d > /etc/keepalived/keepalived.conf && pkill -HUP keepalived`],
      AttachStdout: true,
      AttachStderr: true
    });
    const execStream = await exec.start();
    execStream.on('data', () => {});
    await new Promise((resolve, reject) => {
      execStream.on('end', resolve);
      execStream.on('error', reject);
    });

  } catch (err) {
    console.error('[Reconciler] DNS VIP reconcile failed:', err.message);
  }
};

const reconcileCoreDNS = async (localNodeId) => {
  try {
    // Read settings for DNS forwarder
    const settingsStr = await etcd.get(SETTINGS_KEY).string().catch(() => null);
    const settings = settingsStr ? JSON.parse(settingsStr) : {};
    const dnsForwarder = settings.dnsForwarder || process.env.DNS_FORWARDER || '192.168.1.1';

    const containerName = 'core-docker-coredns';
    let container;
    
    let nodes;
    try {
      nodes = await getNodes();
    } catch (nodeErr) {
      console.warn(`[Reconciler] Failed to fetch nodes for CoreDNS: ${nodeErr.message}. Retrying soon.`);
      return;
    }
    
    // CoreDNS uses etcd/SkyDNS backend — node hostnames are stored in etcd
    // by registerLocalNode and resolved automatically. No hosts plugin needed.
    const corefile = `
.:53 {
    etcd {
        path /skydns
        endpoint ${process.env.ETCD_HOSTS || 'http://core-docker-etcd:2379'}
        fallthrough
    }
    forward . ${dnsForwarder}
    log
    errors
}
`;

    // Write Corefile to a host-volume-backed path so the Docker bind mount
    // in the CoreDNS container actually resolves to a real file on the host.
    // The backend container's /tmp is tmpfs (container-local only), so using
    // /tmp would write to a path invisible to the Docker host.
    let hostBindSrc;
    let corefileChanged = false;
    const volumeBase = '/mnt/backup';
    if (fs.existsSync(volumeBase) && process.env.HOST_BACKUP_PATH) {
      const dir = path.join(volumeBase, 'coredns');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const corefilePath = path.join(dir, 'Corefile');
      // Check if the Corefile content actually changed before writing
      const existing = fs.existsSync(corefilePath) ? fs.readFileSync(corefilePath, 'utf8') : null;
      if (existing !== corefile) {
        fs.writeFileSync(corefilePath, corefile);
        corefileChanged = true;
      }
      hostBindSrc = path.join(resolveHostPath(process.env.HOST_BACKUP_PATH, '/mnt/backup'), 'coredns', 'Corefile');
    } else {
      // Fallback — may not work in read-only containers without tmpfs
      const dir = '/tmp/coredns';
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const fp = path.join(dir, 'Corefile');
      if (fs.existsSync(fp) && fs.lstatSync(fp).isDirectory()) {
        fs.rmdirSync(fp, { recursive: true });
      }
      const existing = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : null;
      if (existing !== corefile) {
        fs.writeFileSync(fp, corefile);
        corefileChanged = true;
      }
      hostBindSrc = fp;
    }

    let image;
    const createContainer = async () => {
      console.log('[Reconciler] Creating CoreDNS container...');
      image = image || 'coredns/coredns:latest';
      await ensureImage(image);

      const isClusterSim = !!process.env.NODE_ID;
      const fallbackPort = isClusterSim ? (5300 + parseInt(localNodeId.replace(/\D/g, '') || 0)) : 5353;
      const finalPort = process.env.DNS_PRODUCTION === 'false' ? fallbackPort.toString() : '53';

      // Bind to the public/client IP so external clients on the network
      // can reach CoreDNS. Falls back to 0.0.0.0 when NODE_CLIENT_IP is
      // not set (e.g. Docker Compose dev mode).
      const bindIp = process.env.NODE_CLIENT_IP || '0.0.0.0';

      console.log(`[Reconciler] CoreDNS binding to ${bindIp}:${finalPort}`);

      container = await docker.createContainer({
        Image: image,
        name: containerName,
        Cmd: ['-conf', '/etc/coredns/Corefile'],
        HostConfig: {
          Binds: [`${hostBindSrc}:/etc/coredns/Corefile`],
          PortBindings: {
            '53/udp': [{ HostIp: bindIp, HostPort: finalPort }],
            '53/tcp': [{ HostIp: bindIp, HostPort: finalPort }]
          },
          RestartPolicy: { Name: 'always' },
          NetworkMode: 'app-net'
        }
      });

      await container.start();
      console.log('[Reconciler] CoreDNS started with volume-mounted Corefile');
    };

    // Clean up any stale/broken CoreDNS container before trying to reconcile.
    // The container may exist in "created" state with a stale network reference
    // (e.g. after docker-compose down/up recreates the app-net network).
    try {
      const stale = docker.getContainer(containerName);
      const staleInspect = await stale.inspect();
      if (!staleInspect.State.Running || staleInspect.State.Error) {
        console.log(`[Reconciler] Removing stale CoreDNS container (state: ${staleInspect.State.Status}, error: "${staleInspect.State.Error || 'none'}")...`);
        await stale.remove({ force: true });
      }
    } catch (e) {
      // 404 means container doesn't exist — that's fine
      if (e.statusCode !== 404) {
        console.warn(`[Reconciler] Unexpected error inspecting CoreDNS: ${e.message}`);
      }
    }

    try {
      container = docker.getContainer(containerName);
      await container.inspect();
    } catch (e) {
      if (e.statusCode === 404) {
        await createContainer();
        corefileChanged = false; // Just created and started — no reload needed
      }
    }

    if (!container) return;

    const inspect = await container.inspect();
    if (!inspect.State.Running) {
      try {
        await container.start();
        corefileChanged = false; // Just started — already reading fresh Corefile
      } catch (startErr) {
        console.error(`[Reconciler] Failed to start CoreDNS: ${startErr.message}. Removing and recreating.`);
        await container.remove({ force: true });
        await createContainer();
      }
    } else {
      if (corefileChanged) {
        try {
          await container.kill({ signal: 'SIGHUP' });
          console.log('[Reconciler] Sent SIGHUP to CoreDNS to reload Corefile');
        } catch (e) {
          console.warn(`[Reconciler] Failed to send SIGHUP to CoreDNS: ${e.message}`);
        }
      }
    }
  } catch (err) {
    console.error('[Reconciler] CoreDNS reconcile failed:', err.message);
  }
};

const reconcileNetworks = async (localNodeId) => {
  console.log('[Reconciler] Starting network reconciliation...');

  let savedContainers;
  try {
    savedContainers = await getContainers();
  } catch (e) {
    console.error(`[Reconciler] Failed to fetch containers for network reconciliation: ${e.message}`);
    return;
  }

  for (const saved of savedContainers) {
    if (saved.current_node && saved.current_node !== localNodeId) continue;
    if (!saved.docker_id) continue;

    try {
      await ensureContainerNetworks(saved.docker_id, saved.name, saved.config?.group || '', saved.config?.internetAccess ?? false);
    } catch (e) {
      console.warn(`[Reconciler] Network reconciliation failed for container ${saved.name}: ${e.message}`);
    }
  }

  let groups;
  try {
    groups = await getGroups();
  } catch (e) {
    console.error(`[Reconciler] Failed to fetch groups for network reconciliation: ${e.message}`);
    return;
  }

  for (const group of groups) {
    try {
      await ensureGroupNetwork(group.name, group.config?.internetAccess ?? false);
    } catch (e) {
      console.warn(`[Reconciler] Network reconciliation failed for group ${group.name}: ${e.message}`);
    }
  }

  console.log('[Reconciler] Network reconciliation completed.');
};

export const reconcileContainers = async (localNodeId) => {
  console.log(`[Reconciler] Starting reconciliation for Node ${localNodeId}...`);
  
  try {
    await reconcileCoreDNS(localNodeId);
    
    // Only bring up the HA IP and Global services if unsealed
    if (!isNodeSealed()) {
      await reconcileDNSVIP(localNodeId);
    } else {
      console.log(`[Reconciler] Node ${localNodeId} is sealed. Skipping HA VIP activation.`);
    }

    let savedContainers;
    try {
      savedContainers = await getContainers();
    } catch (dbErr) {
      console.error(`[Reconciler] Database unavailable: ${dbErr.message}. Aborting reconciliation loop.`);
      return;
    }

    for (const saved of savedContainers) {
    if (saved.current_node && saved.current_node !== localNodeId) {
      // Check if the assigned node is still alive — don't touch its containers
      let nodes;
      try { nodes = await getNodes(); } catch (e) { nodes = []; }
      const nodeAlive = nodes.some(n => n.id === saved.current_node);
      if (nodeAlive) {
        continue;
      }
      // Node is dead — clean up orphaned containers running here
      try {
        const localC = docker.getContainer(saved.name);
        const inspect = await localC.inspect();
        if (inspect.State.Running) {
          console.log(`[Reconciler] Container ${saved.name} is assigned to ${saved.current_node} but running here. Stopping...`);
          await localC.stop();
          await localC.remove();
        }
      } catch (e) {}
      continue;
    }

    if (saved.status !== 'running') continue;

    const { name, config } = saved;
    let container;

    try {
      container = docker.getContainer(name);
      await container.inspect(); 
    } catch (e) {
      if (e.statusCode === 404) {
        console.log(`[Reconciler] Container ${name} missing on this host, creating...`);
        await ensureImage(config.image);

        try {
          const createOpts = await buildCreateOpts(name, config.image, config.env, config.volumes, config.ports, config.restartPolicy, config.resources, config);
          container = await docker.createContainer(createOpts);
          try {
            await ensureContainerNetworks(container.id, name, config.group || '', config.internetAccess ?? false);
          } catch (netErr) {
            console.warn(`[Reconciler] Container ${name} created but network setup failed: ${netErr.message}`);
          }
        } catch (createErr) {
          console.error(`[Reconciler] Failed to create ${name}:`, createErr.message);
          continue;
        }
      }
    }

    try {
    if (!container) return;

    const inspect = await container.inspect();
      await updateContainerDockerId(saved.id, inspect.Id);

      if (!inspect.State.Running) {
        console.log(`[Reconciler] Starting ${name}...`);
        await container.start();
      }

      if (config.proxy?.enabled && config.proxy.uri && config.proxy.port) {
        await addRoute(name, config.proxy.uri, config.proxy.port, config.proxy.domain, config.proxy.sslCert, config.proxy.sslKey);
      }
    } catch (e) {
      console.error(`[Reconciler] Error ensuring ${name} is running:`, e.message);
    }
  }
  await reconcileNetworks(localNodeId);
	  console.log('[Reconciler] Container reconciliation completed.');
} catch (globalErr) {
  console.error(`[Reconciler] Fatal error in reconciliation loop: ${globalErr.message}`);
}
};

let reconcilerInterval = null;

/**
 * Periodic check: promote any etcd learner members that have caught up.
 * This ensures learners eventually become voting members after sync completes.
 * Runs as part of the reconciler loop since it already has the right cadence.
 */
const reconcileLearners = async () => {
  try {
    const container = docker.getContainer('core-docker-etcd');
    const exec = await container.exec({
      Cmd: ['etcdctl', '--endpoints=127.0.0.1:2379', '--command-timeout=10s', 'member', 'list'],
      AttachStdout: true, AttachStderr: true,
    });
    const output = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout')), 15000);
      exec.start(async (err, stream) => {
        if (err) { clearTimeout(timer); reject(err); return; }
        let data = '';
        stream.on('data', c => data += c.toString());
        stream.on('end', () => { clearTimeout(timer); resolve(data); });
      });
    }).catch(() => '');
    if (!output) return;

    for (const line of output.trim().split('\n')) {
      const cols = line.split(', ');
      if (cols.length >= 6 && cols[5] === 'true') {
        const memberName = cols[2];
        console.log(`[Reconciler] Found learner ${memberName}, promoting...`);
        try {
          await promoteEtcdMember(memberName);
          console.log(`[Reconciler] ${memberName} promoted.`);
        } catch (e) {
          console.warn(`[Reconciler] Promote failed for ${memberName}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    if (!e.message?.includes('not found') && !e.message?.includes('UNAVAILABLE')) {
      console.warn(`[Reconciler] Learner check error: ${e.message}`);
    }
  }
};

export const startReconciler = (localNodeId) => {
  if (reconcilerInterval) {
    clearInterval(reconcilerInterval);
  }
  console.log('[Reconciler] Starting periodic DNS reconciliation (120s interval)...');
  reconcilerInterval = setInterval(() => {
    (async () => {
      try {
        await reconcileCoreDNS(localNodeId);
        if (!isNodeSealed()) {
          await reconcileDNSVIP(localNodeId);
        }
        await reconcileNetworks(localNodeId);
        await reconcileLearners();
      } catch (e) {
        console.error('[Reconciler] Periodic reconciliation error:', e.message);
      }
    })();
  }, 120000);
};

export const stopReconciler = () => {
  if (reconcilerInterval) {
    clearInterval(reconcilerInterval);
    reconcilerInterval = null;
    console.log('[Reconciler] Stopped.');
  }
};
