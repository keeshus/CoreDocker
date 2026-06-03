import { readFile } from 'fs/promises';
import docker from './docker.js';
import { getLocalNodeConfig } from './db.js';
import { runEphemeralTask, writeFileToHost, removeFileFromHost, SYSTEM_NAMESPACE, resolveHostPath } from './ephemeral-tasks.js';
import { logEvent } from './logger.js';

const NGINX_CONF_DIR = `${SYSTEM_NAMESPACE}/nginx/conf.d`;
const NGINX_LOCATIONS_DIR = `${SYSTEM_NAMESPACE}/nginx/conf.d/locations`;
const NGINX_SSL_DIR = `${SYSTEM_NAMESPACE}/nginx/ssl`;

// Always HTTPS — self-signed certs generated as fallback, overwritten
// by real certs (e.g. certbot) when available.
export function getNodeUrl(nodeIp) {
  return `https://${nodeIp}:443`;
}

export async function addRoute(containerName, uri, port, domain = null, sslCert = null, sslKey = null) {
    // Validation
    const domainRegex = /^[a-zA-Z0-9.-]+$/;
    const uriRegex = /^\/[a-zA-Z0-9._\-\/]*$/;
    const portRegex = /^\d+$/;

    if (domain && !domainRegex.test(domain)) {
        throw new Error('Invalid domain format');
    }

    const uriPath = uri.startsWith('/') ? uri : `/${uri}`;
    if (!uriRegex.test(uriPath)) {
        throw new Error('Invalid URI format');
    }

    if (!portRegex.test(port.toString())) {
        throw new Error('Invalid port format');
    }

    logEvent('nginx', 'info', `Adding route for ${containerName} (${uriPath})`);

    if (domain && sslCert && sslKey) {
        // Domain specific configuration with SSL
        const certPath = `${NGINX_SSL_DIR}/${containerName}.crt`;
        const keyPath = `${NGINX_SSL_DIR}/${containerName}.key`;
        
        await writeFileToHost(certPath, sslCert);
        await writeFileToHost(keyPath, sslKey);

        const confContent = `
server {
    listen 80;
    server_name ${domain};
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name ${domain};

    ssl_certificate /etc/nginx/ssl/${containerName}.crt;
    ssl_certificate_key /etc/nginx/ssl/${containerName}.key;

    location ${uriPath} {
        proxy_pass http://${containerName}:${port};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;
        const confPath = `${NGINX_CONF_DIR}/${containerName}.conf`;
        await writeFileToHost(confPath, confContent);
    } else {
        // Default behavior (no domain/ssl)
        const confContent = `
location ${uriPath} {
    proxy_pass http://${containerName}:${port};
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
`;
        const confPath = `${NGINX_LOCATIONS_DIR}/${containerName}.conf`;
        await writeFileToHost(confPath, confContent);
    }
    
    await reloadNginx();
}

export async function removeRoute(containerName) {
    const locConfPath = `${NGINX_LOCATIONS_DIR}/${containerName}.conf`;
    const domainConfPath = `${NGINX_CONF_DIR}/${containerName}.conf`;
    const certPath = `${NGINX_SSL_DIR}/${containerName}.crt`;
    const keyPath = `${NGINX_SSL_DIR}/${containerName}.key`;

    logEvent('nginx', 'info', `Removing route for ${containerName}`);

    await Promise.all([
        removeFileFromHost(locConfPath),
        removeFileFromHost(domainConfPath),
        removeFileFromHost(certPath),
        removeFileFromHost(keyPath)
    ]);
    
    await reloadNginx();
}

export async function reloadNginx() {
    try {
        const containers = await docker.listContainers({
            filters: { name: ['^/core-docker-proxy$'] }
        });

        if (containers.length > 0) {
            const nginxContainer = docker.getContainer(containers[0].Id);
            const exec = await nginxContainer.exec({
                Cmd: ['nginx', '-s', 'reload'],
                AttachStdout: true,
                AttachStderr: true
            });
            const stream = await exec.start();
            stream.on('data', () => {});
            stream.pipe(process.stdout);
        }
    } catch (error) {
        console.error('Failed to reload Nginx:', error);
    }
}

/**
 * Connect the nginx proxy container to a Docker network if not already connected.
 */
export async function connectNginxToNetwork(networkName) {
    try {
        const containers = await docker.listContainers({
            filters: { name: ['^/core-docker-proxy$'] }
        });
        if (containers.length === 0) return;

        const nginxContainer = docker.getContainer(containers[0].Id);
        const info = await nginxContainer.inspect();
        const connectedNetworks = info.NetworkSettings?.Networks || {};

        if (connectedNetworks[networkName]) {
            return; // Already connected
        }

        const network = docker.getNetwork(networkName);
        await network.connect({ Container: containers[0].Id });
        console.log(`[NGINX] Connected to network: ${networkName}`);
    } catch (error) {
        if (error.statusCode === 404) return; // Network doesn't exist yet
        console.error(`[NGINX] Failed to connect to network ${networkName}:`, error.message);
    }
}

export async function bootstrapNginx() {
    const CONTAINER_NAME = 'core-docker-proxy';
    const NGINX_IMAGE = process.env.NGINX_IMAGE || 'nginx:latest';

    // Remove stale container if it exists (from a previous failed bootstrap)
    try {
        const container = docker.getContainer(CONTAINER_NAME);
        const info = await container.inspect();
        if (info.State.Running) {
            console.log('[NGINX] Container is already running.');
            return;
        }
        console.log('[NGINX] Removing stale container...');
        await container.remove({ force: true });
    } catch (e) {
        if (e.statusCode !== 404) throw e;
    }

    logEvent('nginx', 'info', 'Bootstrapping dynamic Nginx proxy...');

    const localNode = await getLocalNodeConfig();
    const nodeName = localNode?.name || 'node-1';
    const rawBackupPath = localNode?.backupPath || process.env.HOST_BACKUP_PATH;
    const backupPath = resolveHostPath(rawBackupPath, '/mnt/backup');

    // Ensure the image exists
    try {
        await docker.getImage(NGINX_IMAGE).inspect();
    } catch (e) {
        const stream = await docker.pull(NGINX_IMAGE);
        await new Promise((resolve, reject) => {
            docker.modem.followProgress(stream, (err, res) => err ? reject(err) : resolve(res));
        });
    }

    // Always generate self-signed certs as fallback for HTTPS.
    // Real certs (e.g. from certbot) can overwrite these at the same path.
    const selfSignedPath = `${backupPath}/${SYSTEM_NAMESPACE}/nginx/ssl/host`;
    logEvent('nginx', 'info', 'Generating self-signed certificate for HTTPS...');
    await runEphemeralTask('alpine', [
        'sh', '-c',
        `apk add --no-cache openssl && \
         mkdir -p /data/backup/${SYSTEM_NAMESPACE}/nginx/ssl/host && \
         openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
         -keyout /data/backup/${SYSTEM_NAMESPACE}/nginx/ssl/host/privkey.pem \
         -out /data/backup/${SYSTEM_NAMESPACE}/nginx/ssl/host/fullchain.pem \
         -subj "/CN=${nodeName}.core-docker.local" \
         -addext "subjectAltName=DNS:${nodeName}.core-docker.local,DNS:*.core-docker.local"`
    ]);

    const binds = [
        `${backupPath}/${SYSTEM_NAMESPACE}/nginx/conf.d:/etc/nginx/conf.d`,
        `${backupPath}/${SYSTEM_NAMESPACE}/nginx/ssl:/etc/nginx/ssl`
    ];

    const networks = await docker.listNetworks();
    const targetNetwork = networks.find(n => n.Name === 'app-net' || n.Name.endsWith('_app-net'));
    const networkName = targetNetwork ? targetNetwork.Name : 'app-net';

    const webProxyNetwork = networks.find(n => n.Name === 'web-proxy' || n.Name.endsWith('_web-proxy'));
    if (!webProxyNetwork) {
        console.log('[NGINX] Creating web-proxy network...');
        await docker.createNetwork({ Name: 'web-proxy', CheckDuplicate: true });
    }
    const webProxyName = 'web-proxy';

    // Default nginx config: redirect HTTP to HTTPS, then serve HTTPS with
    // self-signed (or real) certs from the host SSL directory.
    // Includes dynamically added location blocks for container routes.
    const defaultConfContent = `
server {
    listen 80;

    resolver 127.0.0.11 valid=30s;

    # Proxy API requests directly (health check, status, etc.)
    location /api/ {
        proxy_pass http://core-docker-backend:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    ssl_certificate /etc/nginx/ssl/host/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/host/privkey.pem;

    resolver 127.0.0.11 valid=30s;

    # Proxy API requests directly to backend (inter-node cluster traffic)
    location /api/ {
        proxy_pass http://core-docker-backend:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    include /etc/nginx/conf.d/locations/*.conf;

    set $frontend_upstream http://core-docker-frontend:3000;
    location / {
        proxy_pass $frontend_upstream;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;
    await docker.createContainer({
        Image: NGINX_IMAGE,
        name: CONTAINER_NAME,
        ExposedPorts: { '80/tcp': {}, '443/tcp': {} },
        HostConfig: {
            PortBindings: {
                '80/tcp': [{ HostPort: '80' }],
                '443/tcp': [{ HostPort: '443' }]
            },
            Binds: binds,
            Tmpfs: {
                '/etc/nginx/ssl/secrets': 'mode=700'
            },
            RestartPolicy: { Name: 'always' }
        },
        NetworkingConfig: {
            EndpointsConfig: {
                [networkName]: {},
                [webProxyName]: {}
            }
        }
    }).then(container => container.start());

    const nginxContainer = docker.getContainer(CONTAINER_NAME);

    // Copy SSL certs into the container via Docker exec as a fallback
    // in case the bind mount path can't be resolved (rootless Docker, etc.).
    // Read from compose volume mount inside backend (not backupPath which is the host-side path).
    const certDir = `/mnt/backup/${SYSTEM_NAMESPACE}/nginx/ssl/host`;
    for (const certFile of ['fullchain.pem', 'privkey.pem']) {
      const certPath = `${certDir}/${certFile}`;
      try {
        const certContent = await readFile(certPath);
        const b64Cert = certContent.toString('base64');
        const exec = await nginxContainer.exec({
          Cmd: ['sh', '-c', `echo ${b64Cert} | base64 -d > /etc/nginx/ssl/host/${certFile}`],
          AttachStdout: true,
          AttachStderr: true
        });
        await new Promise((resolve, reject) => {
          exec.start((err, stream) => {
            if (err) { reject(err); return; }
            stream.on('end', resolve);
            stream.resume();
          });
        });
      } catch (err) {
        console.error(`[NGINX] Failed to copy ${certFile}: ${err.message}`);
      }
    }

    // Write config into the container via Docker exec (bind mount path resolution
    // differs between rootless Docker and compose-managed mounts).
    const b64Config = Buffer.from(defaultConfContent.trimStart()).toString('base64');
    const writeExec = await nginxContainer.exec({
        Cmd: ['sh', '-c', `echo ${b64Config} | base64 -d > /etc/nginx/conf.d/default.conf`],
        AttachStdout: true,
        AttachStderr: true
    });
    await new Promise((resolve, reject) => {
        writeExec.start((err, stream) => {
            if (err) { reject(err); return; }
            stream.on('end', resolve);
            stream.resume();
        });
    });

    // Reload nginx to pick up the new config
    const reloadExec = await nginxContainer.exec({
        Cmd: ['nginx', '-s', 'reload'],
        AttachStdout: true,
        AttachStderr: true
    });
    await new Promise((resolve, reject) => {
        reloadExec.start((err, stream) => {
            if (err) { reject(err); return; }
            stream.on('end', resolve);
            stream.resume();
        });
    });

    logEvent('nginx', 'info', 'Dynamic Nginx proxy successfully bootstrapped.');
}
