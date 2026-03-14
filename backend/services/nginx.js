import fs from 'fs/promises';
import path from 'path';
import docker from './docker.js';

const NGINX_CONF_DIR = process.env.NODE_ENV === 'development' ? path.join(process.cwd(), 'nginx', 'conf.d') : '/app/nginx/conf.d';
const NGINX_LOCATIONS_DIR = path.join(NGINX_CONF_DIR, 'locations');
const NGINX_SSL_DIR = process.env.NODE_ENV === 'development' ? path.join(process.cwd(), 'nginx', 'ssl') : '/app/nginx/ssl';

export async function addRoute(containerName, uri, port, domain = null, sslCert = null, sslKey = null) {
    // Ensure directories exist
    await fs.mkdir(NGINX_LOCATIONS_DIR, { recursive: true });
    await fs.mkdir(NGINX_SSL_DIR, { recursive: true });

    const uriPath = uri.startsWith('/') ? uri : `/${uri}`;
    
    if (domain && sslCert && sslKey) {
        // Domain specific configuration with SSL
        const certPath = path.join(NGINX_SSL_DIR, `${containerName}.crt`);
        const keyPath = path.join(NGINX_SSL_DIR, `${containerName}.key`);
        
        await fs.writeFile(certPath, sslCert);
        await fs.writeFile(keyPath, sslKey);

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
        const confPath = path.join(NGINX_CONF_DIR, `${containerName}.conf`);
        await fs.writeFile(confPath, confContent);
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
        const confPath = path.join(NGINX_LOCATIONS_DIR, `${containerName}.conf`);
        await fs.writeFile(confPath, confContent);
    }
    
    await reloadNginx();
}

export async function removeRoute(containerName) {
    const locConfPath = path.join(NGINX_LOCATIONS_DIR, `${containerName}.conf`);
    const domainConfPath = path.join(NGINX_CONF_DIR, `${containerName}.conf`);
    const certPath = path.join(NGINX_SSL_DIR, `${containerName}.crt`);
    const keyPath = path.join(NGINX_SSL_DIR, `${containerName}.key`);

    const unlinkSilent = async (p) => {
        try { await fs.unlink(p); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    };

    await Promise.all([
        unlinkSilent(locConfPath),
        unlinkSilent(domainConfPath),
        unlinkSilent(certPath),
        unlinkSilent(keyPath)
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
