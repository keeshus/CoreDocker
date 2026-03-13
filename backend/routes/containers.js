import express from 'express';
import docker from '../services/docker.js';
import { addRoute, removeRoute } from '../services/nginx.js';

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { image, name, env = [], volumes = [], ports = [], restartPolicy = 'unless-stopped', resources = {}, proxy = {} } = req.body;

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

    const PortBindings = {};
    const ExposedPorts = {};
    ports.forEach(p => {
      const cPort = `${p.container}/tcp`;
      ExposedPorts[cPort] = {};
      if (!PortBindings[cPort]) PortBindings[cPort] = [];
      PortBindings[cPort].push({
        HostIp: p.ip || '',
        HostPort: p.host ? p.host.toString() : ''
      });
    });

    const createOpts = {
      Image: image,
      name: name,
      Env: env.map(e => `${e.key}=${e.value}`),
      ExposedPorts,
      HostConfig: {
        RestartPolicy: { Name: restartPolicy },
        Binds: volumes.map(v => `${v.host}:${v.container}`),
        PortBindings,
        Memory: resources.memory ? resources.memory * 1024 * 1024 : 0,
        NanoCPUs: resources.cpu ? resources.cpu * 1000000000 : 0,
        NetworkMode: 'web-proxy'
      }
    };

    const container = await docker.createContainer(createOpts);
    await container.start();

    if (proxy.enabled && proxy.uri && proxy.port) {
      await addRoute(name, proxy.uri, proxy.port, proxy.domain, proxy.sslCert, proxy.sslKey);
    }

    res.status(201).json({ message: 'Container created successfully', id: container.id });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create container', details: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    const inspect = await container.inspect();
    const name = inspect.Name.replace(/^\//, ''); // Remove leading slash
    
    await container.stop();
    await container.remove();
    
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
        // If state is not running and there is an error in the last exit, or if it failed to start
        return { ...c, StateDetails: inspect.State };
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
