import docker from './docker.js';
import etcd, { getLocalNodeConfig } from './db.js';
import { writeFileToHost, removeFileFromHost } from './ephemeral-tasks.js';
import { logEvent } from './logger.js';

const NGINX_CONF_DIR = 'nginx/conf.d';
const NGINX_LOCATIONS_DIR = 'nginx/conf.d/locations';
const NGINX_SSL_DIR = 'nginx/ssl';

export async function addRoute(containerName, uri, port, domain = null, sslCert = null, sslKey = null) {
    const isSealed = await etcd.get('system/master_hash').string().then(hash => !hash); // Basic check, better to use isNodeSealed if available
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
            stream.pipe(process.stdout);
        }
    } catch (error) {
        console.error('Failed to reload Nginx:', error);
    }
}

export async function bootstrapNginx() {
    const CONTAINER_NAME = 'core-docker-proxy';
    const NGINX_IMAGE = 'nginx:latest';
    
    try {
        const container = docker.getContainer(CONTAINER_NAME);
        const info = await container.inspect();
        if (!info.State.Running) {
            await container.start();
        }
        console.log('[NGINX] Container is already running.');
        return;
    } catch (e) {
        if (e.statusCode !== 404) throw e;
    }

    logEvent('nginx', 'info', 'Bootstrapping dynamic Nginx proxy...');

    const localNode = await getLocalNodeConfig();
    const nodeName = localNode?.name || 'node-1';
    const backupPath = localNode?.backupPath || '/data/backup';

    // Ensure the image exists
    try {
        await docker.getImage(NGINX_IMAGE).inspect();
    } catch (e) {
        const stream = await docker.pull(NGINX_IMAGE);
        await new Promise((resolve, reject) => {
            docker.modem.followProgress(stream, (err, res) => err ? reject(err) : resolve(res));
        });
    }

    const networks = await docker.listNetworks();
    const targetNetwork = networks.find(n => n.Name === 'backhaul' || n.Name.endsWith('_backhaul'));
    const networkName = targetNetwork ? targetNetwork.Name : 'backhaul';

    const webProxyNetwork = networks.find(n => n.Name === 'web-proxy' || n.Name.endsWith('_web-proxy'));
    const webProxyName = webProxyNetwork ? webProxyNetwork.Name : 'web-proxy';

    await docker.createContainer({
        Image: NGINX_IMAGE,
        name: CONTAINER_NAME,
        ExposedPorts: { '80/tcp': {}, '443/tcp': {} },
        HostConfig: {
            PortBindings: {
                '80/tcp': [{ HostPort: '80' }],
                '443/tcp': [{ HostPort: '443' }]
            },
            Binds: [
                `${backupPath}/nginx/conf.d:/etc/nginx/conf.d`,
                `/etc/certs/${nodeName}:/etc/nginx/ssl/host:ro`,
                `${backupPath}/nginx/ssl:/etc/nginx/ssl`
            ],
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
    
    logEvent('nginx', 'info', 'Dynamic Nginx proxy successfully bootstrapped.');
}
