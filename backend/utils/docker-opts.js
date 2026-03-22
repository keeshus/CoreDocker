import { getLocalNodeConfig } from '../services/db.js';
import { getSecret } from '../services/secrets.js';

export const buildCreateOpts = async (name, image, env, volumes, ports, restartPolicy, resources, opts = {}) => {
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

  const processedEnv = [];
  for (const e of (env || [])) {
    let val = e.value;
    // Check if it's a secret reference
    const secretMatch = typeof val === 'string' ? val.match(/^\{\{SECRET:(.+)\}\}$/) : null;
    if (secretMatch) {
      const secretKey = secretMatch[1];
      const plaintext = await getSecret(secretKey);
      if (plaintext === null) {
        console.error(`[DockerOpts] Secret ${secretKey} not found for container ${name}.`);
        throw new Error(`Secret ${secretKey} not found`);
      }
      val = plaintext;
    }
    processedEnv.push(`${e.key}=${val}`);
  }

  const createOpts = {
    Image: image,
    name: name,
    Env: processedEnv,
    ExposedPorts,
    HostConfig: {
      RestartPolicy: { Name: restartPolicy || 'unless-stopped' },
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
    let bytes = 0;
    const str = opts.shmSize.toString().toLowerCase().trim();
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
