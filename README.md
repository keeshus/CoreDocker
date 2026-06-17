# CoreDocker

CoreDocker is a full-stack Docker orchestration and management platform with built-in multi-node clustering, high availability, automated backup, and a modern web dashboard.

## Features

### Container Management
- **Full Lifecycle**: Create, start, stop, restart, edit, and delete containers through the dashboard
- **Environment Secrets**: Securely inject secrets as mounted files (not env vars) — not visible via `docker inspect`
- **Volume Management**: Backup and non-backup volume types mapped to configurable host paths
- **Resource Limits**: CPU, memory, tmpfs, shmSize, devices, and stop grace period per container
- **Grouping**: Organize containers into isolated network groups with internet toggle per group
- **Reverse Proxy**: Built-in Nginx reverse proxy with SSL support and custom domain routing

### Multi-Node Clustering
- **Distributed ETCD**: Each node runs an embedded etcd cluster for configuration storage
- **Automated Join**: Nodes can join the cluster via backhaul network during setup
- **SkyDNS**: Node DNS entries written to etcd `/skydns` for real-time CoreDNS resolution
- **Self-Registration**: Each node registers with a unique UUID, name, public/backhaul IPs
- **Cross-Node API Proxying**: One master dashboard manages all nodes — container lists, system info, task logs proxied seamlessly

### High Availability
- **Orchestrator**: Leader-elected service that reschedules orphaned HA containers to healthy nodes
- **Keepalived VIP**: DNS VIP floats between the top 3 nodes via VRRP for instant failover
- **HA Folder Sync**: Per-container data directories (e.g., `/mnt/backup/containers/{name}`) synced via rsync over SSH between nodes
- **Per-Node SSH Keypairs**: Each node generates its own SSH keypair; authorized_keys automatically managed across the cluster via etcd
- **Group & Container HA**: Both individual containers and entire groups can be marked as HA with optional per-container/per-group node allowlists

### Scheduled Tasks
- **Restic S3 Backup**: Automated encrypted backups to any S3-compatible storage, with repository auto-initialization
- **Certbot SSL Renewal**: Automatic Let's Encrypt certificate renewal via DNS-01 challenge (Cloudflare)
- **ETCD Snapshot**: Daily encrypted etcd snapshots with 7-day retention
- **System Log Purge**: Auto-cleanup of old system and task logs
- **HA Folder Sync**: Periodic rsync of HA container data across all cluster nodes
- **Task History**: 30-day task run logs stored as files, viewable with pagination in the dashboard
- **Run Now / Pause / Resume**: Manual task triggering with 3s cooldown, per-task enable/disable

### Security
- **Encrypted Secrets**: All secrets DEK-encrypted (AES-256-CBC) stored in etcd
- **System Secrets Hidden**: Internal secrets (cert creds, S3 keys, backup passwords) stored with `__system__/` prefix and filtered from the Secrets tab
- **Master Password**: Required for initial setup and node unseal; brute-force protection via exponential backoff
- **DEK Rotation**: Data Encryption Key can be rotated (re-encrypts all secrets, containers, and groups)
- **File-Based Secrets Injection**: Secrets mounted as read-only files at `/run/secrets/` using a statically-linked busybox — works on scratch/distroless containers
- **CORS & Rate Limiting**: Configurable CORS origin, per-endpoint rate limiting, and mutation limits

### Networking
- **CoreDNS**: Automatic DNS entries for every node and container via etcd `/skydns`
- **DNS VIP**: Configurable virtual IP for external DNS resolution, managed by Keepalived
- **Dual-NIC Support**: Public (client) and backhaul (cluster-internal) network segregation
- **SSL Termination**: Self-signed certificates generated on first boot; real Let's Encrypt certs via certbot task
- **HTTPS Only**: All traffic through nginx HTTPS, HTTP 301-redirects to HTTPS

### Node Management
- **Auto-Registration**: Nodes register automatically on setup/unseal
- **Naming**: DNS-safe node names, editable via the dashboard
- **System Monitoring**: Per-node CPU and memory resource tracking
- **System Containers**: ETCD, Nginx, CoreDNS, Keepalived all managed as Docker containers by the backend

### Cluster Settings UI
- **Global DNS Configuration**: DNS VIP address, interface, and upstream forwarder
- **TLS Certificates**: Domain and Cloudflare API token for Let's Encrypt
- **Restic Backup**: S3 endpoint, bucket, and credential configuration
- **SSH User**: Configurable non-root SSH user for HA folder sync
- **Startup Readiness Check**: Dashboard shows "CoreDocker is starting up..." spinner until etcd is fully responsive

## Project Structure

- `backend/`: Node.js/Express API server
  - `services/`: Docker interaction, etcd clustering, reconciler, scheduler, secrets, nginx, HA
  - `routes/`: API endpoints for containers, nodes, secrets, tasks, groups, settings
  - `migrations/`: Automated data migrations with `up()`/`down()` support
- `frontend/`: Next.js 16 dashboard application with server-side rendering
  - `components/`: ContainerRow, CreateContainer, CreateGroup, TasksTab, SecretsTab, ClusterSettings, NodeSettings, UnsealView, SetupView
- `vm/`: KVM-based 3-node cluster provisioning scripts for testing and production
  - `setup-cluster.sh`: Fully automated 3-node KVM cluster with dual-NIC (public + backhaul)
  - `vm-bootstrap.sh`: Node initialization script (Docker install, repo extraction, first boot)
  - `update-cluster.sh`: Parallel code update across all cluster VMs
  - `destroy-cluster.sh`: Clean teardown of all VMs and networks

## Getting Started

### Prerequisites
- Docker and Docker Compose v2
- Access to `/var/run/docker.sock`
- For VM cluster: KVM/libvirt (`virsh`, `virt-install`, `genisoimage`, `qemu-img`)

### Quick Start (Single Node)
```bash
# Clone and start
git clone https://github.com/keeshus/CoreDocker.git
cd CoreDocker
docker compose up --build
```

### Cluster Setup (3 Nodes on KVM)
```bash
sudo bash vm/setup-cluster.sh --recreate
```

### Access
- **Dashboard:** `https://localhost:80` (or node-1's IP in cluster mode)
- **Setup:** First visit shows the setup page — create a new cluster or join an existing one

## Development

```bash
npm install
npm run backend:dev     # Backend on port 3000
npm run frontend:dev    # Frontend with hot reload
```

## Testing

```bash
npm test                # Unit tests (Vitest, 249+ tests)
npm run test:e2e        # E2E tests on running VMs (requires KVM cluster)
npm run test:e2e:full   # Provision VMs → run tests → destroy VMs
npm run test:watch      # Watch mode for unit tests
```

## Security

This application mounts the Docker socket (`/var/run/docker.sock`). This grants full administrative control over your Docker daemon. **Only deploy in secure, trusted environments.**

## License

MIT — see [LICENSE](LICENSE).
