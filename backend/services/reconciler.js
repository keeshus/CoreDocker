import docker from './docker.js';
import { getContainers, updateContainerDockerId, getLocalNodeConfig, getNodes } from './db.js';
import { addRoute } from './nginx.js';
import etcd from './db.js';

const SETTINGS_KEY = 'cluster/settings';

const reconcileKeepalived = async () => {
  try {
    const settingsStr = await etcd.get(SETTINGS_KEY).string();
    const settings = settingsStr ? JSON.parse(settingsStr) : null;
    
    if (!settings || !settings.sharedIpPool || !settings.backhaulNetwork) {
      return;
    }

    const localNode = await getLocalNodeConfig();
    if (!localNode || !localNode.id) return;

    const allNodes = await getNodes();
    const sortedNodes = allNodes.sort((a, b) => a.id.localeCompare(b.id));
    const nodeIndex = sortedNodes.findIndex(n => n.id === localNode.id);

    if (nodeIndex === -1) return;

    const vip = settings.sharedIpPool.split('-')[0].trim();
    const isMaster = nodeIndex === 0;
    const priority = 100 - (nodeIndex * 10);
    const containerName = 'core-docker-keepalived';

    const config = `
vrrp_instance VI_1 {
    state ${isMaster ? 'MASTER' : 'BACKUP'}
    interface eth0
    virtual_router_id 51
    priority ${priority}
    advert_int 1
    authentication {
        auth_type PASS
        auth_pass 1111
    }
    virtual_ipaddress {
        ${vip}
    }
}
`;

    let container;
    try {
      container = docker.getContainer(containerName);
      await container.inspect();
    } catch (e) {
      if (e.statusCode === 404) {
        console.log('Creating Keepalived container...');
        // We assume the image is available or was built during deployment
        // For simplicity in this reconciler, we use a pre-built image or build it
        container = await docker.createContainer({
          Image: 'core-docker-keepalived:latest',
          name: containerName,
          HostConfig: {
            CapAdd: ['NET_ADMIN', 'NET_BROADCAST'],
            NetworkMode: 'backhaul', // Assuming backhaul network exists
            RestartPolicy: { Name: 'always' }
          }
        });
      }
    }

    const inspect = await container.inspect();
    if (!inspect.State.Running) {
      await container.start();
    }

    // Update configuration inside container
    // This is a simplified approach; in production, you might mount a volume
    const exec = await container.exec({
      Cmd: ['sh', '-c', `echo "${config.replace(/"/g, '\\"')}" > /etc/keepalived/keepalived.conf && pkill -HUP keepalived`],
      AttachStdout: true,
      AttachStderr: true
    });
    await exec.start();

  } catch (error) {
    console.error('Keepalived reconciliation failed:', error.message);
  }
};

export const reconcileContainers = async () => {
  console.log('Starting container reconciliation...');
  
  await reconcileKeepalived();

  const savedContainers = await getContainers();

  for (const saved of savedContainers) {
    if (saved.status !== 'running') continue;

    const { name, config } = saved;
    let container;

    try {
      container = docker.getContainer(name);
      await container.inspect(); // Check if exists
    } catch (e) {
      if (e.statusCode === 404) {
        // Container missing, let's create it
        console.log(`Container ${name} missing, creating...`);
        try {
          await docker.getImage(config.image).inspect();
        } catch (imageErr) {
          console.log(`Pulling image ${config.image}...`);
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

        const localNode = await getLocalNodeConfig();
        const binds = (config.volumes || []).map(v => {
          let hostPath = v.host;
          if (v.type === 'backup' || v.type === 'non-backup') {
            const basePath = v.type === 'backup' ? localNode.backupPath : localNode.nonBackupPath;
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
            
            try {
              await network.connect({ Container: container.id });
            } catch(e) {
              console.log(`Could not connect ${container.id} to ${networkName}`, e.message);
            }
          }

        } catch (createErr) {
          console.error(`Failed to create container ${name}:`, createErr.message);
          continue;
        }
      } else {
        console.error(`Error inspecting container ${name}:`, e.message);
        continue;
      }
    }

    try {
      const inspect = await container.inspect();
      await updateContainerDockerId(saved.id, inspect.Id);

      if (!inspect.State.Running) {
        console.log(`Starting container ${name}...`);
        await container.start();
      }

      if (config.proxy?.enabled && config.proxy.uri && config.proxy.port) {
        console.log(`Ensuring nginx route for ${name}...`);
        await addRoute(name, config.proxy.uri, config.proxy.port, config.proxy.domain, config.proxy.sslCert, config.proxy.sslKey);
      }
    } catch (e) {
      console.error(`Error ensuring container ${name} is running:`, e.message);
    }
  }
  console.log('Container reconciliation completed.');
};
