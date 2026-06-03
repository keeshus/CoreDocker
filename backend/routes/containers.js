import express from 'express';
import docker from '../services/docker.js';
import { etcd, saveContainer, deleteContainer, getContainerByName, getLocalNodeConfig, getContainers, getNodes } from '../services/db.js';
import { ensureContainerNetworks, removeContainerNetworks } from '../services/network-manager.js';
import { addRoute, removeRoute, getNodeUrl } from '../services/nginx.js';
import { nodeId as localNodeId } from '../config.js';
import { generateClusterToken } from '../services/secrets.js';
import { buildCreateOpts } from '../utils/docker-opts.js';
import { withTimeout } from '../utils/timeout.js';
import { withContainerLock } from '../utils/locks.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';

const router = express.Router();

const IMAGE_NAME_RE = /^[a-zA-Z0-9._\-\/]+(:[a-zA-Z0-9._-]+)?$/;
const NAME_RE = /^[a-zA-Z0-9._-]+$/;
const URI_RE = /^\/[a-zA-Z0-9._\-\/]*$/;
const PORT_RE = /^\d+$/;
const DEVICES_RE = /^[a-zA-Z0-9_\/.,:]+$/;

const IMAGE_PULL_TIMEOUT = 5 * 60 * 1000;
const CONTAINER_OP_TIMEOUT = 30 * 1000;

function validateContainerInput(body) {
  const errors = [];
  if (body.name && !NAME_RE.test(body.name)) {
    errors.push('Invalid container name: only alphanumeric, dots, dashes, and underscores allowed');
  }
  if (body.image && !IMAGE_NAME_RE.test(body.image)) {
    errors.push('Invalid image name format');
  }
  if (body.proxy?.enabled) {
    if (body.proxy.uri && !URI_RE.test(body.proxy.uri)) {
      errors.push('Invalid proxy URI format');
    }
    if (body.proxy.port && !PORT_RE.test(String(body.proxy.port))) {
      errors.push('Invalid proxy port');
    }
  }
  if (body.devices && !DEVICES_RE.test(body.devices)) {
    errors.push('Invalid devices format');
  }
  return errors;
}

async function ensureImage(image) {
  try {
    await withTimeout(docker.getImage(image).inspect(), CONTAINER_OP_TIMEOUT);
  } catch (e) {
    await withTimeout(new Promise((resolve, reject) => {
      docker.pull(image, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err, res) => err ? reject(err) : resolve(res));
      });
    }), IMAGE_PULL_TIMEOUT, `Image pull timed out for ${image}`);
  }
}

async function checkPrivilegedAllowed(privileged) {
  if (!privileged) return;
  const settings = await etcd.get('core/settings').string();
  const allowPrivileged = settings ? JSON.parse(settings).allowPrivileged === true : false;
  if (!allowPrivileged) {
    throw Object.assign(new Error('Privileged containers are disabled in cluster settings'), { code: 'PRIVILEGED_DISABLED', status: 403 });
  }
}

const proxyToNode = async (nodeId, req, res) => {
  const targetNodeId = nodeId || 'master';
  if (targetNodeId !== localNodeId) {
    const nodes = await getNodes();
    const node = nodes.find(n => n.id === targetNodeId);
    if (node) {
      const token = generateClusterToken({ node: localNodeId });
      const url = `${getNodeUrl(node.ip)}${req.originalUrl}`;

      const options = {
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      };

      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        options.body = JSON.stringify(req.body);
      }

      const resp = await fetch(url, options);

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

const ensureNetworkConnections = async (dockerContainerId, group, internetAccess, name) => {
  await ensureContainerNetworks(dockerContainerId, name, group, internetAccess);
};

router.post('/', async (req, res) => {
  try {
    const { image, name, env = [], volumes = [], ports = [], restartPolicy = 'unless-stopped', resources = {}, proxy = {}, group = '', ha = false, tmpfs = '', stopGracePeriod = '', shmSize = '', devices = '', privileged = false, internetAccess = false } = req.body;

    const validationErrors = validateContainerInput(req.body);
    if (validationErrors.length > 0) {
      return res.status(400).json({ error: validationErrors.join('; '), code: 'VALIDATION_ERROR' });
    }

    if (!resources || !resources.memory || !resources.cpu) {
      return res.status(400).json({ error: 'Memory and CPU limits are mandatory.', code: 'VALIDATION_ERROR' });
    }

    const targetNode = req.body.current_node || localNodeId;

    const proxied = await proxyToNode(targetNode, req, res);
    if (proxied !== false) return;

    const containerId = uuidv4();
    const config = {
      image, name, env, volumes, ports, restartPolicy, resources, proxy, group,
      ha, ha_allowed_nodes: req.body.ha_allowed_nodes || [],
      tmpfs, stopGracePeriod, shmSize, devices, privileged, internetAccess,
    };

    await withContainerLock(`name:${name}`, async () => {
      const existing = await getContainerByName(name);
      if (existing) {
        throw Object.assign(new Error(`Container with name "${name}" already exists`), { status: 409, code: 'CONFLICT' });
      }

      await checkPrivilegedAllowed(privileged);
      await ensureImage(image);

      const createOpts = await buildCreateOpts(name, image, env, volumes, ports, restartPolicy, resources, { tmpfs, stopGracePeriod, shmSize, devices, privileged });
      const container = await withTimeout(docker.createContainer(createOpts), CONTAINER_OP_TIMEOUT, 'Container creation timed out');

      try {
        await saveContainer(containerId, name, config, 'running', container.id, nodeId);

        try {
          await ensureNetworkConnections(container.id, group, internetAccess, name);

          if (proxy.enabled && proxy.uri && proxy.port) {
            await addRoute(name, proxy.uri, proxy.port, proxy.domain, proxy.sslCert, proxy.sslKey);
          }

          res.status(201).json({ message: 'Container created successfully', id: container.id, db_id: containerId });
        } catch (err) {
          await deleteContainer(containerId).catch(() => {});
          await container.remove({ force: true }).catch(() => {});
          throw err;
        }
      } catch (err) {
        await container.remove({ force: true }).catch(() => {});
        throw err;
      }
    });
  } catch (error) {
    if (error.status === 403) return res.status(403).json({ error: error.message, code: error.code });
    if (error.status === 409) return res.status(409).json({ error: error.message, code: error.code });
    res.status(500).json({ error: 'Failed to create container', details: error.message, code: 'CONTAINER_CREATE_FAILED' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { image, name, env = [], volumes = [], ports = [], restartPolicy = 'unless-stopped', resources = {}, proxy = {}, group = '', ha = false, tmpfs = '', stopGracePeriod = '', shmSize = '', devices = '', privileged = false, internetAccess = false } = req.body;

    const validationErrors = validateContainerInput(req.body);
    if (validationErrors.length > 0) {
      return res.status(400).json({ error: validationErrors.join('; '), code: 'VALIDATION_ERROR' });
    }

    let dbC = await etcd.get(`core/containers/${id}`);
    if (!dbC) {
      const all = await getContainers();
      dbC = all.find(c => c.docker_id === id);
    }

    const proxied = await proxyToNode(dbC?.current_node, req, res);
    if (proxied !== false) return;

    const existingNode = localNodeId;

    await withContainerLock(id, async () => {
      let container = docker.getContainer(id);
      let inspect;
      try {
        inspect = await withTimeout(container.inspect(), CONTAINER_OP_TIMEOUT, 'Container inspect timed out');
      } catch (e) {
        throw Object.assign(new Error('Container not found in Docker'), { status: 404, code: 'NOT_FOUND' });
      }

      const oldName = inspect.Name.replace(/^\//, '');
      const dbContainer = await getContainerByName(oldName);
      const rollback = {
        dockerId: container.id,
        oldName,
        dbId: dbContainer ? dbContainer.id : null,
        dbRecord: dbContainer ? JSON.parse(JSON.stringify(dbContainer)) : null,
      };

      let dbId = dbContainer ? dbContainer.id : uuidv4();
      if (dbContainer && oldName !== name) {
        dbId = uuidv4();
      }

      const config = { image, name, env, volumes, ports, restartPolicy, resources, proxy, group, ha, ha_allowed_nodes: req.body.ha_allowed_nodes || [], tmpfs, stopGracePeriod, shmSize, devices, privileged, internetAccess };

      await checkPrivilegedAllowed(privileged);

      // Stop old container but do NOT remove it yet
      await withTimeout(container.stop(), CONTAINER_OP_TIMEOUT, 'Container stop timed out');

      let newContainer;
      try {
        await ensureImage(image);

        const createOpts = await buildCreateOpts(name, image, env, volumes, ports, restartPolicy, resources, { tmpfs, stopGracePeriod, shmSize, devices, privileged });
        newContainer = await withTimeout(docker.createContainer(createOpts), CONTAINER_OP_TIMEOUT, 'Container creation timed out');

        try {
          if (dbContainer && oldName !== name) {
            await deleteContainer(dbContainer.id).catch(() => {});
          }

          await saveContainer(dbId, name, config, 'running', newContainer.id, existingNode);

          // Now safe to remove old container
          await container.remove({ force: true }).catch(() => {});
          await removeRoute(oldName).catch(() => {});

          await withTimeout(newContainer.start(), CONTAINER_OP_TIMEOUT, 'Container start timed out');
          await ensureNetworkConnections(newContainer.id, group, internetAccess, name);

          if (proxy.enabled && proxy.uri && proxy.port) {
            await addRoute(name, proxy.uri, proxy.port, proxy.domain, proxy.sslCert, proxy.sslKey);
          }

          res.json({ message: 'Container updated successfully', id: newContainer.id, db_id: dbId });
        } catch (err) {
          // Rollback: remove new container, restart old, restore etcd
          await newContainer.remove({ force: true }).catch(() => {});
          try {
            await docker.getContainer(rollback.dockerId).start();
          } catch (e) {}
          if (rollback.dbRecord) {
            await saveContainer(rollback.dbId, rollback.dbRecord.name, rollback.dbRecord.config, rollback.dbRecord.status, rollback.dockerId, rollback.dbRecord.current_node).catch(() => {});
          }
          throw err;
        }
      } catch (err) {
        // Rollback: restart old container (no new container was created)
        try {
          await docker.getContainer(rollback.dockerId).start();
        } catch (e) {
          console.error(`[Rollback] Failed to restart old container ${rollback.oldName}:`, e.message);
        }
        throw err;
      }
    });
  } catch (error) {
    if (error.status === 403) return res.status(403).json({ error: error.message, code: error.code });
    if (error.status === 404) return res.status(404).json({ error: error.message, code: error.code });
    res.status(500).json({ error: 'Failed to update container', details: error.message, code: 'CONTAINER_UPDATE_FAILED' });
  }
});

router.post('/:id/persist', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    const inspect = await container.inspect();
    const name = inspect.Name.replace(/^\//, '');

    const dbContainer = await getContainerByName(name);
    if (dbContainer) {
      return res.status(400).json({ error: 'Container is already persisted', code: 'ALREADY_PERSISTED' });
    }

    const env = (inspect.Config.Env || []).map(e => {
      const idx = e.indexOf('=');
      if (idx === -1) return { key: e, value: '' };
      return { key: e.substring(0, idx), value: e.substring(idx + 1) };
    });
    await getLocalNodeConfig();
    const volumes = [];

    if (inspect.HostConfig.Binds) {
      for (const b of inspect.HostConfig.Binds) {
        const parts = b.split(':');
        const oldHost = parts[0];
        const containerPath = parts[1];

        const folderName = containerPath.replace(/^\//, '').replace(/\//g, '_');
        const newHostPath = `/mnt/backup/${name}/${folderName}`;

        console.log(`Migrating volume ${oldHost} -> ${newHostPath}`);
        try {
          await fs.mkdir(newHostPath, { recursive: true });
          await fs.cp(oldHost, newHostPath, { recursive: true });
        } catch (e) {
          console.error(`Error copying volume ${oldHost}:`, e);
        }

        volumes.push({ type: 'backup', host: folderName, container: containerPath });
      }
    }

    if (inspect.Mounts) {
      for (const m of inspect.Mounts) {
        if (m.Type === 'volume' && m.Source) {
          const folderName = m.Destination.replace(/^\//, '').replace(/\//g, '_');
          const newHostPath = `/mnt/backup/${name}/${folderName}`;

          console.log(`Migrating docker volume ${m.Source} -> ${newHostPath}`);
          try {
            await fs.mkdir(newHostPath, { recursive: true });
            await fs.cp(m.Source, newHostPath, { recursive: true });
          } catch (e) {
            console.error(`Error copying volume ${m.Source}:`, e);
          }

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
      privileged: false,
      internetAccess: false,
    };

    // Save old container id for rollback
    const oldContainerId = container.id;

    await withTimeout(container.stop(), CONTAINER_OP_TIMEOUT, 'Container stop timed out');
    await withTimeout(container.remove({ force: true }), CONTAINER_OP_TIMEOUT, 'Container remove timed out');

    const containerId = uuidv4();

    try {
      await saveContainer(containerId, name, config, 'running');

      const createOpts = await buildCreateOpts(name, config.image, env, volumes, ports, config.restartPolicy, resources, config);
      const newContainer = await withTimeout(docker.createContainer(createOpts), CONTAINER_OP_TIMEOUT, 'Container creation timed out');

      try {
        await saveContainer(containerId, name, config, 'running', newContainer.id);
        await withTimeout(newContainer.start(), CONTAINER_OP_TIMEOUT, 'Container start timed out');
        await ensureNetworkConnections(newContainer.id, '', false, name);

        res.json({ message: 'Container migrated successfully', db_id: containerId });
      } catch (err) {
        await newContainer.remove({ force: true }).catch(() => {});
        throw err;
      }
    } catch (err) {
      // Rollback: try to recreate the original container
      try {
        const restoreOpts = await buildCreateOpts(name, inspect.Config.Image, env, [], ports, inspect.HostConfig.RestartPolicy.Name || 'unless-stopped', resources, config);
        const restored = await docker.createContainer(restoreOpts);
        await restored.start();
      } catch (restoreErr) {
        console.error(`[Rollback] Failed to restore container ${name}:`, restoreErr.message);
      }
      throw err;
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to persist container', details: error.message, code: 'PERSIST_FAILED' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let dbContainer = await etcd.get(`core/containers/${id}`);
    if (!dbContainer) {
      const all = await getContainers();
      dbContainer = all.find(c => c.docker_id === id);
    }

    const proxied = await proxyToNode(dbContainer?.current_node, req, res);
    if (proxied !== false) return;

    await withContainerLock(id, async () => {
      const container = docker.getContainer(id);
      let inspect;
      try {
        inspect = await withTimeout(container.inspect(), CONTAINER_OP_TIMEOUT, 'Container inspect timed out');
      } catch (e) {
        // Container already gone — clean up etcd record and return success
        if (dbContainer) {
          await deleteContainer(dbContainer.id).catch(() => {});
        }
        await removeRoute(id).catch(() => {});
        await removeContainerNetworks(id).catch(() => {});
        return res.json({ message: 'Container was already removed' });
      }

      const name = inspect.Name.replace(/^\//, '');

      await withTimeout(container.stop(), CONTAINER_OP_TIMEOUT, 'Container stop timed out');
      await withTimeout(container.remove({ force: true }), CONTAINER_OP_TIMEOUT, 'Container remove timed out');

      // Best-effort cleanup — don't fail if etcd/route/network removal fails
      const errors = [];
      if (dbContainer) {
        try { await deleteContainer(dbContainer.id); } catch (e) { errors.push(`etcd: ${e.message}`); }
      }
      try { await removeRoute(name); } catch (e) { errors.push(`route: ${e.message}`); }
      try { await removeContainerNetworks(id); } catch (e) { errors.push(`network: ${e.message}`); }

      if (errors.length > 0) {
        console.warn(`[Container] Delete cleanup warnings for ${name}: ${errors.join(', ')}`);
      }

      res.json({ message: 'Container removed successfully' });
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove container', details: error.message, code: 'CONTAINER_DELETE_FAILED' });
  }
});

router.get('/', async (req, res) => {
  try {
    // If requesting containers from a specific remote node, proxy the request
    const targetNode = req.query.node;
    if (targetNode && targetNode !== localNodeId) {
      const nodes = await getNodes();
      const node = nodes.find(n => n.id === targetNode);
      if (node) {
        const token = generateClusterToken({ node: localNodeId });
        const url = `${getNodeUrl(node.ip)}/api/containers${req.query.system ? '?system=true' : ''}`;
        const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!resp.ok) return res.status(resp.status).json(await resp.json().catch(() => ({})));
        return res.json(await resp.json());
      }
    }

    const dbContainers = await getContainers();
    const localContainers = await docker.listContainers({ all: true });

    const enrichedContainers = await Promise.all(dbContainers.map(async (dbC) => {
      let liveData = null;
      if (dbC.current_node === (localNodeId)) {
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
            NetworkSettings: inspect.NetworkSettings,
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
        internetAccess: dbC.config?.internetAccess || false,
        current_node: dbC.current_node,
      };
    }));

    for (const local of localContainers) {
      if (!enrichedContainers.find(c => c.Id === local.Id)) {
        enrichedContainers.push({
          ...local,
          isPersisted: false,
          current_node: localNodeId,
        });
      }
    }

    res.json(enrichedContainers);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch containers', details: error.message, code: 'CONTAINER_LIST_FAILED' });
  }
});

router.get('/:id/logs', async (req, res) => {
  const id = req.params.id;
  try {
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
    res.status(500).json({ error: e.message, code: 'LOG_STREAM_FAILED' });
  }
});

export default router;