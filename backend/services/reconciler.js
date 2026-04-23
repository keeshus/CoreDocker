import docker from './docker.js';
import { getContainers, updateContainerDockerId, getNodes } from './db.js';
import { addRoute } from './nginx.js';
import { isNodeSealed } from './secrets.js';
import { buildCreateOpts } from '../utils/docker-opts.js';
import etcd from './db.js';
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
    if (!settingsStr) return; // Database not ready or settings missing
    
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

    const priority = 100 - (nodeIndex * 10);
    const config = `
vrrp_instance VI_DNS {
    state ${nodeIndex === 0 ? 'MASTER' : 'BACKUP'}
    interface eth0
    virtual_router_id 53
    priority ${priority}
    advert_int 1
    authentication {
        auth_type PASS
        auth_pass 2222
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
            NetworkMode: 'backhaul',
            RestartPolicy: { Name: 'always' }
          }
        });
      }
    }

    const inspect = await container.inspect();
    if (!inspect.State.Running) {
      await container.start();
    }

    await container.exec({
      Cmd: ['sh', '-c', `echo "${config.replace(/"/g, '\\"')}" > /etc/keepalived/keepalived.conf && pkill -HUP keepalived`],
      AttachStdout: true,
      AttachStderr: true
    }).then(exec => exec.start());

  } catch (err) {
    console.error('[Reconciler] DNS VIP reconcile failed:', err.message);
    throw err; 
  }
};

const reconcileCoreDNS = async (localNodeId) => {
  try {
    const containerName = 'core-docker-coredns';
    let container;
    
    let nodes;
    try {
      nodes = await getNodes();
    } catch (nodeErr) {
      console.warn(`[Reconciler] Failed to fetch nodes for CoreDNS: ${nodeErr.message}. Retrying soon.`);
      return; // Skip this run, will be retried by the main loop
    }
    
    let staticEntries = '';
    for (const node of nodes) {
      staticEntries += `    hosts {
        ${node.ip} ${node.id}.core-docker.local
        fallthrough
    }\n`;
    }

    const corefile = `
.:53 {
${staticEntries}
    etcd {
        path /skydns
        endpoint ${process.env.ETCD_HOSTS || 'http://core-docker-etcd:2379'}
    }
    forward . 192.168.1.1
    log
    errors
}
`;

    // Always ensure the config directory and file exist on the host
    const configDir = '/tmp/coredns';
    const corefilePath = path.join(configDir, 'Corefile');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    // If it exists but is a directory (docker sometimes creates it as such if mount fails)
    if (fs.existsSync(corefilePath) && fs.lstatSync(corefilePath).isDirectory()) {
      fs.rmdirSync(corefilePath, { recursive: true });
    }
    fs.writeFileSync(corefilePath, corefile);

    try {
      container = docker.getContainer(containerName);
      await container.inspect();
    } catch (e) {
      if (e.statusCode === 404) {
        console.log('[Reconciler] Creating CoreDNS container...');
        const image = 'coredns/coredns:latest';
        await ensureImage(image);

        // Detect if we are in local development/simulation vs production
        const isClusterSim = !!process.env.NODE_ID;
        const dnsHostPort = isClusterSim ? (5300 + parseInt(localNodeId.replace(/\D/g, '') || 0)) : 5353;
        
        // If the user wants port 53 in production, we check an env var or assume lack of NODE_ID
        const finalPort = process.env.DNS_PRODUCTION === 'true' ? '53' : dnsHostPort.toString();

        console.log(`[Reconciler] CoreDNS binding to host port ${finalPort}`);

        container = await docker.createContainer({
          Image: image,
          name: containerName,
          Cmd: ['-conf', '/etc/coredns/Corefile'],
          HostConfig: {
            Binds: [`${configDir}/Corefile:/etc/coredns/Corefile`],
            PortBindings: {
              '53/udp': [{ HostPort: finalPort }],
              '53/tcp': [{ HostPort: finalPort }]
            },
            RestartPolicy: { Name: 'always' },
            NetworkMode: 'backhaul'
          }
        });
        
        await container.start();
        console.log('[Reconciler] CoreDNS started with volume-mounted Corefile');
      }
    }

    const inspect = await container.inspect();
    if (!inspect.State.Running) {
      await container.start();
    } else {
      // CoreDNS supports SIGHUP to reload config.
      try {
        await container.kill({ signal: 'SIGHUP' });
        console.log('[Reconciler] Sent SIGHUP to CoreDNS to reload Corefile');
      } catch (e) {
        console.warn(`[Reconciler] Failed to send SIGHUP to CoreDNS: ${e.message}`);
      }
    }
  } catch (err) {
    console.error('[Reconciler] CoreDNS reconcile failed:', err.message);
    throw err;
  }
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
          if (config.group) {
            const networkName = `group-${config.group}`;
            let network;
            try {
              network = docker.getNetwork(networkName);
              await network.inspect();
            } catch (netErr) {
              network = await docker.createNetwork({ Name: networkName });
            }
            try { await network.connect({ Container: container.id }); } catch(e) {}
          }
        } catch (createErr) {
          console.error(`[Reconciler] Failed to create ${name}:`, createErr.message);
          continue;
        }
      }
    }

    try {
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
  console.log('[Reconciler] Container reconciliation completed.');
} catch (globalErr) {
  console.error(`[Reconciler] Fatal error in reconciliation loop: ${globalErr.message}`);
}
};
