import docker from './docker.js';
import { getContainers, updateContainerDockerId } from './db.js';
import { addRoute } from './nginx.js';

export const reconcileContainers = async () => {
  console.log('Starting container reconciliation...');
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

        const createOpts = {
          Image: config.image,
          name: name,
          Env: (config.env || []).map(e => `${e.key}=${e.value}`),
          ExposedPorts,
          HostConfig: {
            RestartPolicy: { Name: config.restartPolicy || 'unless-stopped' },
            Binds: (config.volumes || []).map(v => `${v.host}:${v.container}`),
            PortBindings,
            Memory: config.resources?.memory ? config.resources.memory * 1024 * 1024 : 0,
            NanoCPUs: config.resources?.cpu ? config.resources.cpu * 1000000000 : 0,
            NetworkMode: 'web-proxy'
          }
        };

        try {
          container = await docker.createContainer(createOpts);
          
          if (config.networkContainers && config.networkContainers.length > 0) {
            const networkName = `net-${name}`;
            let network;
            try {
              network = docker.getNetwork(networkName);
              await network.inspect();
            } catch (netErr) {
              network = await docker.createNetwork({ Name: networkName });
            }
            
            await network.connect({ Container: container.id });
            for (const targetContainerId of config.networkContainers) {
              try {
                await network.connect({ Container: targetContainerId });
              } catch(e) {
                console.log(`Could not connect ${targetContainerId} to ${networkName}`, e.message);
              }
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
