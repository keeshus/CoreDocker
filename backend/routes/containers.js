import express from 'express';
import docker from '../services/docker.js';
import etcd from '../services/db.js';
import { addRoute, removeRoute } from '../services/nginx.js';
import { saveContainer, deleteContainer, getContainerByName, getLocalNodeConfig, getContainers, getNodes } from '../services/db.js';
import { generateClusterToken } from '../services/secrets.js';
import { buildCreateOpts } from '../utils/docker-opts.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';

const router = express.Router();

const proxyToNode = async (nodeId, req, res) => {
  const targetNodeId = nodeId || 'master';
  if (targetNodeId !== (process.env.NODE_ID || 'master')) {
    const nodes = await getNodes();
    const node = nodes.find(n => n.id === targetNodeId);
    if (node) {
      const token = generateClusterToken({ node: process.env.NODE_ID });
      const url = `http://${node.ip}:${process.env.PORT || 3000}${req.originalUrl}`;
      
      const options = {
        method: req.method,
        headers: { 
          'Content-Type': 'application/json', 
          'Authorization': `Bearer ${token}` 
        }
      };

      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        options.body = JSON.stringify(req.body);
      }

      const resp = await fetch(url, options);

      // Handle stream for logs
      if (req.path.endsWith('/logs') && resp.ok) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        if (!resp.body) return res.end();
        const reader = resp.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        return res.end();
      }

      const data = await resp.json();
      return res.status(resp.status).json(data);
    }
  }
  return false;
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
    
    if (!resources || !resources.memoryLimit || !resources.cpuLimit) {
      return res.status(400).json({ error: 'Memory and CPU limits are mandatory.' });
    }

    const nodeId = req.body.current_node || process.env.NODE_ID || 'master';

    const proxied = await proxyToNode(nodeId, req, res);
    if (proxied !== false) return;

    const containerId = uuidv4();
    const config = { 
      image, name, env, volumes, ports, restartPolicy, resources, proxy, group, 
      ha, ha_allowed_nodes: req.body.ha_allowed_nodes || [],
      tmpfs, stopGracePeriod, shmSize, devices, privileged 
    };
    
    // Security check for privileged containers
    if (privileged) {
      const settings = await etcd.get('core/settings').string();
      const allowPrivileged = settings ? JSON.parse(settings).allowPrivileged === true : false;
      if (!allowPrivileged) {
        return res.status(403).json({ error: 'Privileged containers are disabled in cluster settings' });
      }
    }

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
    const id = req.params.id;
    const { image, name, env = [], volumes = [], ports = [], restartPolicy = 'unless-stopped', resources = {}, proxy = {}, group = '', ha = false, tmpfs = '', stopGracePeriod = '', shmSize = '', devices = '', privileged = false } = req.body;
    
    // Check if remote
    let dbC = await etcd.get(`core/containers/${id}`);
    if (!dbC) {
      const all = await getContainers();
      dbC = all.find(c => c.docker_id === id);
    }

    const proxied = await proxyToNode(dbC?.current_node, req, res);
    if (proxied !== false) return;

    // 1. Get the existing container and remove it
    let container = docker.getContainer(id);
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
    
    // Security check for privileged containers
    if (privileged) {
      const settings = await etcd.get('core/settings').string();
      const allowPrivileged = settings ? JSON.parse(settings).allowPrivileged === true : false;
      if (!allowPrivileged) {
        return res.status(403).json({ error: 'Privileged containers are disabled in cluster settings' });
      }
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
          await fs.mkdir(newHostPath, { recursive: true });
          await fs.cp(oldHost, newHostPath, { recursive: true });
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
            await fs.mkdir(newHostPath, { recursive: true });
            await fs.cp(m.Source, newHostPath, { recursive: true });
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
    const id = req.params.id;
    // Check if this is a docker ID or our DB ID
    let dbContainer = await etcd.get(`core/containers/${id}`);
    if (!dbContainer) {
      // Try searching by docker_id
      const all = await getContainers();
      dbContainer = all.find(c => c.docker_id === id);
    }

    const proxied = await proxyToNode(dbContainer?.current_node, req, res);
    if (proxied !== false) return;

    const container = docker.getContainer(id);
    const inspect = await container.inspect();
    const name = inspect.Name.replace(/^\//, ''); // Remove leading slash
    
    await container.stop();
    await container.remove();
    
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
    const dbContainers = await getContainers();
    const localContainers = await docker.listContainers({ all: true });
    
    const enrichedContainers = await Promise.all(dbContainers.map(async (dbC) => {
      let liveData = null;
      if (dbC.current_node === (process.env.NODE_ID || 'master')) {
        try {
          const container = docker.getContainer(dbC.docker_id || dbC.name);
          const inspect = await container.inspect();
          liveData = {
            Id: inspect.Id,
            Names: [inspect.Name],
            Image: inspect.Config.Image,
            State: inspect.State.Status,
            Status: inspect.State.Status,
            StateDetails: inspect.State,
            NetworkSettings: inspect.NetworkSettings
          };
        } catch (e) {}
      }

      return {
        Id: dbC.docker_id || dbC.id,
        Names: [`/${dbC.name}`],
        Image: dbC.config.image,
        State: liveData?.State || 'unknown',
        Status: liveData?.Status || 'Remote/Unknown',
        StateDetails: liveData?.StateDetails,
        NetworkSettings: liveData?.NetworkSettings || { Networks: {} },
        isPersisted: true,
        persistedConfig: dbC.config,
        current_node: dbC.current_node
      };
    }));

    // Also include local containers that are NOT persisted
    for (const local of localContainers) {
      if (!enrichedContainers.find(c => c.Id === local.Id)) {
        enrichedContainers.push({
          ...local,
          isPersisted: false,
          current_node: process.env.NODE_ID || 'master'
        });
      }
    }

    res.json(enrichedContainers);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch containers', details: error.message });
  }
});

router.get('/:id/logs', async (req, res) => {
  const id = req.params.id;
  try {
    // Check if remote
    let dbC = await etcd.get(`core/containers/${id}`);
    if (!dbC) {
      const all = await getContainers();
      dbC = all.find(c => c.docker_id === id);
    }

    const proxied = await proxyToNode(dbC?.current_node, req, res);
    if (proxied !== false) return;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const container = docker.getContainer(id);
    container.logs({ follow: true, stdout: true, stderr: true, tail: 100 }, (err, stream) => {
      if (err) return res.end();
      stream.on('data', (chunk) => {
        const cleanLine = chunk.toString('utf8', 8);
        res.write(`data: ${JSON.stringify({ log: cleanLine })}\n\n`);
      });
      req.on('close', () => stream.destroy && stream.destroy());
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
