import express from 'express';
import docker from '../services/docker.js';
import { addRoute, removeRoute } from '../services/nginx.js';
import { saveContainer, deleteContainer, getContainerByName } from '../services/db.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

const buildCreateOpts = (name, image, env, volumes, ports, restartPolicy, resources) => {
  const PortBindings = {};
  const ExposedPorts = {};
  (ports || []).forEach(p => {
    const cPort = `${p.container}/tcp`;
    ExposedPorts[cPort] = {};
    if (!PortBindings[cPort]) PortBindings[cPort] = [];
    PortBindings[cPort].push({
      HostIp: p.ip || '',
      HostPort: p.host ? p.host.toString() : ''
    });
  });

  return {
    Image: image,
    name: name,
    Env: (env || []).map(e => `${e.key}=${e.value}`),
    ExposedPorts,
    HostConfig: {
      RestartPolicy: { Name: restartPolicy },
      Binds: (volumes || []).map(v => `${v.host}:${v.container}`),
      PortBindings,
      Memory: resources?.memory ? resources.memory * 1024 * 1024 : 0,
      NanoCPUs: resources?.cpu ? resources.cpu * 1000000000 : 0,
      NetworkMode: 'web-proxy'
    }
  };
};

const ensureNetworkConnections = async (name, containerId, networkContainers) => {
  if (networkContainers && networkContainers.length > 0) {
    const networkName = `net-${name}`;
    let network;
    try {
      network = docker.getNetwork(networkName);
      await network.inspect();
    } catch (e) {
      network = await docker.createNetwork({ Name: networkName });
    }
    
    try { await network.connect({ Container: containerId }); } catch(e) {}
    
    for (const targetContainerId of networkContainers) {
      try {
        await network.connect({ Container: targetContainerId });
      } catch (e) {
        console.error(`Could not connect ${targetContainerId} to ${networkName}`, e);
      }
    }
  }
};

router.post('/', async (req, res) => {
  try {
    const { image, name, env = [], volumes = [], ports = [], restartPolicy = 'unless-stopped', resources = {}, proxy = {}, networkContainers = [] } = req.body;

    const containerId = uuidv4();
    const config = { image, name, env, volumes, ports, restartPolicy, resources, proxy, networkContainers };
    
    // Save to DB first as intent
    await saveContainer(containerId, name, config, 'running');

    // Pull image if not exists
    try {
      await docker.getImage(image).inspect();
    } catch (e) {
      await new Promise((resolve, reject) => {
        docker.pull(image, (err, stream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (err, res) => err ? reject(err) : resolve(res));
        });
      });
    }

    const createOpts = buildCreateOpts(name, image, env, volumes, ports, restartPolicy, resources);
    const container = await docker.createContainer(createOpts);
    
    // Update docker_id in DB
    await saveContainer(containerId, name, config, 'running', container.id);

    await container.start();
    await ensureNetworkConnections(name, container.id, networkContainers);

    if (proxy.enabled && proxy.uri && proxy.port) {
      await addRoute(name, proxy.uri, proxy.port, proxy.domain, proxy.sslCert, proxy.sslKey);
    }

    res.status(201).json({ message: 'Container created successfully', id: container.id, db_id: containerId });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create container', details: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { image, name, env = [], volumes = [], ports = [], restartPolicy = 'unless-stopped', resources = {}, proxy = {}, networkContainers = [] } = req.body;
    
    // 1. Get the existing container and remove it
    let container = docker.getContainer(req.params.id);
    let inspect;
    try {
      inspect = await container.inspect();
    } catch(e) {
      return res.status(404).json({ error: 'Container not found in Docker' });
    }

    const oldName = inspect.Name.replace(/^\//, '');
    await container.stop();
    await container.remove();
    await removeRoute(oldName);

    // 2. Update DB intent
    const config = { image, name, env, volumes, ports, restartPolicy, resources, proxy, networkContainers };
    const dbContainer = await getContainerByName(oldName);
    let dbId = dbContainer ? dbContainer.id : uuidv4();
    
    if (dbContainer && oldName !== name) {
      // Name changed, we might need to recreate the DB entry to avoid unique constraint issues if we just updated it, 
      // but ON CONFLICT(name) handles it. Actually better to delete old name and create new if name changes.
      await deleteContainer(dbContainer.id);
      dbId = uuidv4();
    }
    
    await saveContainer(dbId, name, config, 'running');

    // Pull image if not exists
    try {
      await docker.getImage(image).inspect();
    } catch (e) {
      await new Promise((resolve, reject) => {
        docker.pull(image, (err, stream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (err, res) => err ? reject(err) : resolve(res));
        });
      });
    }

    const createOpts = buildCreateOpts(name, image, env, volumes, ports, restartPolicy, resources);
    container = await docker.createContainer(createOpts);
    
    await saveContainer(dbId, name, config, 'running', container.id);

    await container.start();
    await ensureNetworkConnections(name, container.id, networkContainers);

    if (proxy.enabled && proxy.uri && proxy.port) {
      await addRoute(name, proxy.uri, proxy.port, proxy.domain, proxy.sslCert, proxy.sslKey);
    }

    res.json({ message: 'Container updated successfully', id: container.id, db_id: dbId });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update container', details: error.message });
  }
});

router.post('/:id/persist', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    const inspect = await container.inspect();
    const name = inspect.Name.replace(/^\//, '');

    const dbContainer = await getContainerByName(name);
    if (dbContainer) {
      return res.status(400).json({ error: 'Container is already persisted' });
    }

    // Infer config from inspect data
    const env = (inspect.Config.Env || []).map(e => {
      const idx = e.indexOf('=');
      if (idx === -1) return { key: e, value: '' };
      return { key: e.substring(0, idx), value: e.substring(idx + 1) };
    });

    const volumes = (inspect.HostConfig.Binds || []).map(b => {
      const parts = b.split(':');
      return { host: parts[0], container: parts[1] };
    });

    const ports = [];
    if (inspect.NetworkSettings.Ports) {
      Object.keys(inspect.NetworkSettings.Ports).forEach(cPort => {
        const mappings = inspect.NetworkSettings.Ports[cPort];
        const cPortNum = cPort.split('/')[0];
        if (mappings) {
          mappings.forEach(m => {
            ports.push({ ip: m.HostIp, host: m.HostPort, container: cPortNum });
          });
        }
      });
    }

    const resources = {
      cpu: inspect.HostConfig.NanoCPUs ? inspect.HostConfig.NanoCPUs / 1000000000 : null,
      memory: inspect.HostConfig.Memory ? inspect.HostConfig.Memory / (1024 * 1024) : null,
    };

    const config = {
      image: inspect.Config.Image,
      name: name,
      env,
      volumes,
      ports,
      restartPolicy: inspect.HostConfig.RestartPolicy.Name || 'unless-stopped',
      resources,
      proxy: { enabled: false, uri: '', port: '', domain: '', sslCert: '', sslKey: '' },
      networkContainers: []
    };

    const containerId = uuidv4();
    await saveContainer(containerId, name, config, 'running', inspect.Id);

    res.json({ message: 'Container persisted successfully', db_id: containerId });
  } catch (error) {
    res.status(500).json({ error: 'Failed to persist container', details: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    const inspect = await container.inspect();
    const name = inspect.Name.replace(/^\//, ''); // Remove leading slash
    
    await container.stop();
    await container.remove();
    
    const dbContainer = await getContainerByName(name);
    if (dbContainer) {
      await deleteContainer(dbContainer.id);
    }

    // Attempt to remove proxy route if it exists
    await removeRoute(name);
    
    res.json({ message: 'Container removed successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove container', details: error.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    const enrichedContainers = await Promise.all(containers.map(async (c) => {
      try {
        const container = docker.getContainer(c.Id);
        const inspect = await container.inspect();
        const name = inspect.Name.replace(/^\//, '');
        const dbContainer = await getContainerByName(name);
        
        let config = dbContainer ? dbContainer.config : null;

        return { ...c, StateDetails: inspect.State, isPersisted: !!dbContainer, persistedConfig: config };
      } catch (e) {
        return c;
      }
    }));
    res.json(enrichedContainers);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch containers', details: error.message });
  }
});

router.get('/:id/logs', (req, res) => {
  const containerId = req.params.id;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const container = docker.getContainer(containerId);
  container.logs({ follow: true, stdout: true, stderr: true, tail: 100 }, (err, stream) => {
    if (err) return res.end();
    stream.on('data', (chunk) => {
      const cleanLine = chunk.toString('utf8', 8);
      res.write(`data: ${JSON.stringify({ log: cleanLine })}\n\n`);
    });
    req.on('close', () => stream.destroy && stream.destroy());
  });
});

export default router;
