import { getLocalNodeConfig } from '../services/db.js';
import { getSecret } from '../services/secrets.js';
import { resolveHostPath } from '../services/ephemeral-tasks.js';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

const VALID_RESTART_POLICIES = ['no', 'always', 'unless-stopped', 'on-failure'];
const NONBACKUP_BASE = '/mnt/non-backup/__system__/secrets';
const IMAGE_NAME_RE = /^[a-zA-Z0-9._\-\/]+(:[a-zA-Z0-9._-]+)?$/;
// Pattern-based blocklist for host devices — reject any block device, memory, or port.
// USB devices (/dev/ttyUSB*, /dev/bus/usb/) and other safe devices pass through.
const BLOCKED_DEVICE_PATTERNS = [
  /^\/dev\/sd/,      // SCSI/SATA disks
  /^\/dev\/nvme/,    // NVMe SSDs
  /^\/dev\/vd/,      // virtio block devices
  /^\/dev\/xvd/,     // Xen virtual disks
  /^\/dev\/hd/,      // IDE disks
  /^\/dev\/disk\//,  // disk by-id/by-uuid/by-path
  /^\/dev\/loop/,    // loop devices
  /^\/dev\/dm-/,     // device mapper
  /^\/dev\/mem/,     // /dev/mem (physical memory)
  /^\/dev\/kmem/,    // /dev/kmem (kernel memory)
  /^\/dev\/port/,    // /dev/port (I/O port access)
  /^\/dev\/md/,      // software RAID
  /^\/dev\/mmcblk/,  // eMMC/SD block devices
];
const isDeviceBlocked = (path) => BLOCKED_DEVICE_PATTERNS.some(p => p.test(path));

export const buildCreateOpts = async (name, image, env, volumes, ports, restartPolicy, resources, opts = {}) => {
  if (!IMAGE_NAME_RE.test(image)) {
    throw new Error(`Invalid image name: ${image}`);
  }

  if (!VALID_RESTART_POLICIES.includes(restartPolicy)) {
    throw new Error(`Invalid restart policy: ${restartPolicy}`);
  }

  const PortBindings = {};
  const ExposedPorts = {};
  (ports || []).forEach(p => {
    const cPort = `${p.container}/tcp`;
    ExposedPorts[cPort] = {};
    if (!PortBindings[cPort]) PortBindings[cPort] = [];
    PortBindings[cPort].push({
      HostIp: p.ip || '',
      HostPort: p.host ? p.host.toString() : '',
    });
  });
  await getLocalNodeConfig();
  const binds = (volumes || []).map(v => {
    // Reject volumes with unknown types — only 'backup' and 'non-backup' are supported.
    // Raw host paths without a type would be a path traversal / host escape.
    if (!v.type) {
      throw new Error('Volume type is required (must be "backup" or "non-backup")');
    }
    if (v.type !== 'backup' && v.type !== 'non-backup') {
      throw new Error(`Invalid volume type: ${v.type}`);
    }
    let hostPath = v.host;
    const basePath = v.type === 'backup' ?
      resolveHostPath(process.env.HOST_BACKUP_PATH, '/mnt/backup') :
      resolveHostPath(process.env.HOST_NONBACKUP_PATH, '/mnt/non-backup');
    const folderName = v.host ? `/${v.host}` : '';
    const safeContainerPath = v.container.replace(/^\//, '').replace(/\//g, '_');
    hostPath = `${basePath}/${name}${folderName ? folderName : '/' + safeContainerPath}`;
    return `${hostPath}:${v.container}`;
  });

  // Init script that loads mounted secret files as env vars before exec'ing the real command.
// Written to host once, bind-mounted into every container that uses secrets.
const SECRETS_INIT_SCRIPT_HOST = path.join(NONBACKUP_BASE, '.secrets-init.sh');
const SECRETS_INIT_SCRIPT_CONTAINER = '/run/secrets-init/.init.sh';
const INIT_SCRIPT_CONTENT = `#!/bin/sh
# Load all secret files as env vars
for f in /run/secrets/*; do
  [ -f "\$f" ] || continue
  k=\$(basename "\$f")
  export "\$k=\$(cat "\$f")"
done
exec "\$@"
`;
// Ensure the init script exists on the host (idempotent)
try {
  mkdirSync(path.dirname(SECRETS_INIT_SCRIPT_HOST), { recursive: true });
  let needsWrite = true;
  try {
    if (readFileSync(SECRETS_INIT_SCRIPT_HOST, 'utf8') === INIT_SCRIPT_CONTENT) needsWrite = false;
  } catch {}
  if (needsWrite) writeFileSync(SECRETS_INIT_SCRIPT_HOST, INIT_SCRIPT_CONTENT, { mode: 0o755 });
} catch {}

let hasSecrets = false;
const processedEnv = [];
for (const e of (env || [])) {
  let val = e.value;
  const secretMatch = typeof val === 'string' ? val.match(/^\{\{SECRET:(.+)}}$/) : null;
  if (secretMatch) {
    hasSecrets = true;
    const secretKey = secretMatch[1];
    const plaintext = await getSecret(secretKey);
    if (plaintext === null) {
      console.error(`[DockerOpts] Secret ${secretKey} not found for container ${name}.`);
      throw new Error(`Secret ${secretKey} not found`);
    }

    // Write secret to host file and bind-mount it read-only
    const hostDir = path.join(NONBACKUP_BASE, name);
    const hostFile = path.join(hostDir, secretKey);
    mkdirSync(hostDir, { recursive: true });
    writeFileSync(hostFile, String(plaintext), { mode: 0o600 });

    const containerMount = `/run/secrets/${secretKey}`;
    binds.push(`${hostFile}:${containerMount}:ro`);

    // Set _FILE env var so compliant images can use it directly
    processedEnv.push(`${e.key}_FILE=${containerMount}`);
  } else {
    processedEnv.push(`${e.key}=${val}`);
  }
}

// Ensure a statically-linked busybox is available on the host so the init script
// works even in scratch/distroless containers (zero deps on the target image).
const BUSYBOX_HOST = path.join(NONBACKUP_BASE, '.busybox');
const BUSYBOX_CONTAINER = '/run/secrets-init/.busybox';
try {
  if (!existsSync(BUSYBOX_HOST)) {
    // Copy busybox from the backend's own Alpine filesystem
    writeFileSync(BUSYBOX_HOST, readFileSync('/bin/busybox'));
    try { chmodSync(BUSYBOX_HOST, 0o755); } catch {}
  }
} catch {}

// Entrypoint override — init script loads secrets then execs the original command.
// Uses our own statically-linked busybox so it works on any container including scratch.
let entrypointOverride = null;
if (hasSecrets) {
  binds.push(
    `${BUSYBOX_HOST}:${BUSYBOX_CONTAINER}`,          // rw so init can self-destruct
    `${SECRETS_INIT_SCRIPT_HOST}:${SECRETS_INIT_SCRIPT_CONTAINER}:ro`,
  );
  entrypointOverride = [BUSYBOX_CONTAINER, 'sh', SECRETS_INIT_SCRIPT_CONTAINER, '--'];
}

  const createOpts = {
    Image: image,
    name: name,
    User: opts.privileged ? '0:0' : '1000:1000',
    Env: processedEnv,
    ExposedPorts,
    HostConfig: {
      RestartPolicy: { Name: restartPolicy || 'unless-stopped' },
      Binds: binds,
      PortBindings,
      Memory: resources?.memory ? resources.memory * 1024 * 1024 : 0,
      NanoCPUs: resources?.cpu ? resources.cpu * 1000000000 : 0,
      Privileged: opts.privileged || false,
    },
  };

  if (entrypointOverride) {
    createOpts.Entrypoint = entrypointOverride;
  }

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
    let bytes;
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
      if (!pathOnHost.startsWith('/')) return null;
      if (isDeviceBlocked(pathOnHost)) return null;
      return {
        PathOnHost: pathOnHost,
        PathInContainer: pathInContainer || pathOnHost,
        CgroupPermissions: cgroupPermissions || 'rwm',
      };
    }).filter(Boolean);
  }

  return createOpts;
};
