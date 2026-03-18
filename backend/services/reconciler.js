import docker from './docker.js';
import { getContainers, updateContainerDockerId, getLocalNodeConfig, getNodes } from './db.js';
import { addRoute } from './nginx.js';
import etcd from './db.js';

const SETTINGS_KEY = 'cluster/settings';

const reconcileDNSVIP = async (localNodeId) => {
  try {
    const settingsStr = await etcd.get(SETTINGS_KEY).string();
    const settings = settingsStr ? JSON.parse(settingsStr) : null;
    
    if (!settings || !settings.dnsVip) return;

    const allNodes = await getNodes();
    const sortedNodes = allNodes.sort((a, b) => a.id.localeCompare(b.id));
    const nodeIndex = sortedNodes.findIndex(n => n.id === localNodeId);

    const containerName = 'core-docker-keepalived-dns';

    // Only run on top 3 nodes
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
        container = await docker.createContainer({
          Image: 'alpine:latest', // We will install keepalived via entrypoint or use a custom image
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
  }
};

const reconcileCoreDNS = async () => {
  try {
    const containerName = 'core-docker-coredns';
    let container;
    try {
      container = docker.getContainer(containerName);
      await container.inspect();
    } catch (e) {
      if (e.statusCode === 404) {
        console.log('[Reconciler] Creating CoreDNS container...');
        const corefile = `
.:53 {
    etcd {
        path /skydns
        endpoint ${process.env.ETCD_HOSTS || 'http://core-docker-etcd:2379'}
    }
    forward . 192.168.1.1
    log
    errors
}
`;
        container = await docker.createContainer({
          Image: 'coredns/coredns:latest',
          name: containerName,
          Cmd: ['-conf', '/etc/coredns/Corefile'],
          HostConfig: {
            // In a real setup we'd use a proper mount, using sh to create it for this demo
            Binds: [],
            PortBindings: { '53/udp': [{ HostPort: '53' }], '53/tcp': [{ HostPort: '53' }] },
            RestartPolicy: { Name: 'always' },
            NetworkMode: 'backhaul'
          }
        });
        
        // Start it once so we can exec the config in
        await container.start();
        await container.exec({
          Cmd: ['sh', '-c', `mkdir -p /etc/coredns && echo "${corefile.replace(/"/g, '\\"')}" > /etc/coredns/Corefile`],
        }).then(exec => exec.start());
        await container.restart();
      }
    }

    const inspect = await container.inspect();
    if (!inspect.State.Running) {
      await container.start();
    }
  } catch (err) {
    console.error('[Reconciler] CoreDNS reconcile failed:', err.message);
  }
};

export const reconcileContainers = async (localNodeId) => {
  console.log(`[Reconciler] Starting reconciliation for Node ${localNodeId}...`);
  
  await reconcileCoreDNS();
  await reconcileDNSVIP(localNodeId);

  const savedContainers = await getContainers();

  for (const saved of savedContainers) {
    if (saved.current_node !== localNodeId) {
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
        try {
          await docker.getImage(config.image).inspect();
        } catch (imageErr) {
          await new Promise((resolve, reject) => {
            docker.pull(config.image, (err, stream) => {
              if (err) return reject(err);
              docker.modem.followProgress(stream, (err, res) => err ? reject(err) : resolve(res));
            });
          });
        }

        const PortBindings = {};
        const ExposedPorts = {};
        (config.ports || []).forEach(p => {
          const cPort = `${p.container}/tcp`;
          ExposedPorts[cPort] = {};
          if (!PortBindings[cPort]) PortBindings[cPort] = [];
          PortBindings[cPort].push({
            HostIp: p.ip || '',
            HostPort: p.host ? p.host.toString() : ''
          });
        });

        const localNodeConfig = await getLocalNodeConfig();
        const binds = (config.volumes || []).map(v => {
          let hostPath = v.host;
          if (v.type === 'backup' || v.type === 'non-backup') {
            const basePath = v.type === 'backup' ? localNodeConfig.backupPath : localNodeConfig.nonBackupPath;
            const folderName = v.host ? `/${v.host}` : '';
            const safeContainerPath = v.container.replace(/^\//, '').replace(/\//g, '_');
            hostPath = `${basePath}/${name}${folderName ? folderName : '/' + safeContainerPath}`;
          }
          return `${hostPath}:${v.container}`;
        });

        const createOpts = {
          Image: config.image,
          name: name,
          Env: (config.env || []).map(e => `${e.key}=${e.value}`),
          ExposedPorts,
          HostConfig: {
            RestartPolicy: { Name: config.restartPolicy || 'unless-stopped' },
            Binds: binds,
            PortBindings,
            Memory: config.resources?.memory ? config.resources.memory * 1024 * 1024 : 0,
            NanoCPUs: config.resources?.cpu ? config.resources.cpu * 1000000000 : 0,
            NetworkMode: 'web-proxy'
          }
        };

        try {
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
};
