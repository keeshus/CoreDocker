import express from 'express';
import docker from '../services/docker.js';
import { addRoute, removeRoute } from '../services/nginx.js';
import { exec } from 'child_process';
import util from 'util';
const execAsync = util.promisify(exec);
import { saveContainer, deleteContainer, getContainerByName, getLocalNodeConfig } from '../services/db.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

const buildCreateOpts = async (name, image, env, volumes, ports, restartPolicy, resources, opts = {}) => {
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

  const localNode = await getLocalNodeConfig();
  
  const binds = (volumes || []).map(v => {
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
    Image: image,
    name: name,
    Env: (env || []).map(e => `${e.key}=${e.value}`),
    ExposedPorts,
    HostConfig: {
      RestartPolicy: { Name: restartPolicy },
      Binds: binds,
      PortBindings,
      Memory: resources?.memory ? resources.memory * 1024 * 1024 : 0,
      NanoCPUs: resources?.cpu ? resources.cpu * 1000000000 : 0,
      NetworkMode: 'web-proxy',
      Privileged: opts.privileged || false,
    }
  };

  if (opts.stopGracePeriod) {
    createOpts.StopTimeout = parseInt(opts.stopGracePeriod, 10);
  }

  if (opts.tmpfs) {
    const tmpfsObj = {};
    opts.tmpfs.split(',').forEach(p => {
      if (p.trim()) tmpfsObj[p.trim()] = '';
    });
    createOpts.HostConfig.Tmpfs = tmpfsObj;
  }

  if (opts.shmSize) {
    // E.g. "64m" or "1g" or bytes
    let bytes = 0;
    const str = opts.shmSize.toLowerCase().trim();
    if (str.endsWith('g')) bytes = parseInt(str) * 1024 * 1024 * 1024;
    else if (str.endsWith('m')) bytes = parseInt(str) * 1024 * 1024;
    else if (str.endsWith('k')) bytes = parseInt(str) * 1024;
    else bytes = parseInt(str) || 0;
    if (bytes > 0) createOpts.HostConfig.ShmSize = bytes;
  }

  if (opts.devices) {
    createOpts.HostConfig.Devices = opts.devices.split(',').map(d => {
      const [pathOnHost, pathInContainer, cgroupPermissions] = d.trim().split(':');
      if (!pathOnHost) return null;
      return {
        PathOnHost: pathOnHost,
        PathInContainer: pathInContainer || pathOnHost,
        CgroupPermissions: cgroupPermissions || 'rwm'
      };
    }).filter(Boolean);
  }

  return createOpts;
};

const ensureNetworkConnections = async (group, containerId) => {
  if (group) {
    const networkName = `group-${group}`;
    let network;
    try {
      network = docker.getNetwork(networkName);
      await network.inspect();
    } catch (e) {
      network = await docker.createNetwork({ Name: networkName });
    }
    
    try { await network.connect({ Container: containerId }); } catch(e) {}
  }
};

router.post('/', async (req, res) => {
  try {
    const { image, name, env = [], volumes = [], ports = [], restartPolicy = 'unless-stopped', resources = {}, proxy = {}, group = '', ha = false, tmpfs = '', stopGracePeriod = '', shmSize = '', devices = '', privileged = false } = req.body;

    const containerId = uuidv4();
    const nodeId = req.body.current_node || process.env.NODE_ID || 'master'; 
    const config = { 
      image, name, env, volumes, ports, restartPolicy, resources, proxy, group, 
      ha, ha_allowed_nodes: req.body.ha_allowed_nodes || [],
      tmpfs, stopGracePeriod, shmSize, devices, privileged 
    };
    
    // Save to DB first as intent
    await saveContainer(containerId, name, config, 'running', null, nodeId);

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

    const createOpts = await buildCreateOpts(name, image, env, volumes, ports, restartPolicy, resources, { tmpfs, stopGracePeriod, shmSize, devices, privileged });
    const container = await docker.createContainer(createOpts);
    
    // Update docker_id in DB
    await saveContainer(containerId, name, config, 'running', container.id);

    await container.start();
    await ensureNetworkConnections(group, container.id);

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
    const { image, name, env = [], volumes = [], ports = [], restartPolicy = 'unless-stopped', resources = {}, proxy = {}, group = '', ha = false, tmpfs = '', stopGracePeriod = '', shmSize = '', devices = '', privileged = false } = req.body;
    
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
    const config = { image, name, env, volumes, ports, restartPolicy, resources, proxy, group, ha, tmpfs, stopGracePeriod, shmSize, devices, privileged };
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

    const createOpts = await buildCreateOpts(name, image, env, volumes, ports, restartPolicy, resources, { tmpfs, stopGracePeriod, shmSize, devices, privileged });
    container = await docker.createContainer(createOpts);
    
    await saveContainer(dbId, name, config, 'running', container.id);

    await container.start();
    await ensureNetworkConnections(group, container.id);

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

    const localNode = await getLocalNodeConfig();
    const volumes = [];
    
    // Process Binds
    if (inspect.HostConfig.Binds) {
      for (const b of inspect.HostConfig.Binds) {
        const parts = b.split(':');
        const oldHost = parts[0];
        const containerPath = parts[1];
        
        // Auto-migrate to backup path
        const folderName = containerPath.replace(/^\//, '').replace(/\//g, '_');
        const newHostPath = `${localNode.backupPath}/${name}/${folderName}`;
        
        console.log(`Migrating volume ${oldHost} -> ${newHostPath}`);
        try {
          await execAsync(`mkdir -p "${newHostPath}" && cp -R "${oldHost}"/* "${newHostPath}"/ || true`);
        } catch(e) {
          console.error(`Error copying volume ${oldHost}:`, e);
        }
        
        volumes.push({ type: 'backup', host: folderName, container: containerPath });
      }
    }
    
    // Process Mounts (Docker named volumes)
    if (inspect.Mounts) {
      for (const m of inspect.Mounts) {
        if (m.Type === 'volume' && m.Source) {
          const folderName = m.Destination.replace(/^\//, '').replace(/\//g, '_');
          const newHostPath = `${localNode.backupPath}/${name}/${folderName}`;
          
          console.log(`Migrating docker volume ${m.Source} -> ${newHostPath}`);
          try {
            await execAsync(`mkdir -p "${newHostPath}" && cp -R "${m.Source}"/* "${newHostPath}"/ || true`);
          } catch(e) {
            console.error(`Error copying volume ${m.Source}:`, e);
          }
          
          // Only add if not already in volumes
          if (!volumes.find(v => v.container === m.Destination)) {
            volumes.push({ type: 'backup', host: folderName, container: m.Destination });
          }
        }
      }
    }

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
      group: '',
      ha: false,
      tmpfs: '',
      stopGracePeriod: '',
      shmSize: '',
      devices: '',
      privileged: false
    };

    // Stop and remove old container
    await container.stop();
    await container.remove();

    const containerId = uuidv4();
    await saveContainer(containerId, name, config, 'running');

    // Create and start new container via CoreDocker configuration
    const createOpts = await buildCreateOpts(name, config.image, env, volumes, ports, config.restartPolicy, resources, config);
    const newContainer = await docker.createContainer(createOpts);
    await saveContainer(containerId, name, config, 'running', newContainer.id);
    await newContainer.start();

    res.json({ message: 'Container migrated successfully', db_id: containerId });
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
