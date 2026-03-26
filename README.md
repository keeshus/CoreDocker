# CoreDocker

CoreDocker is a comprehensive, full-stack Docker orchestration and management dashboard. It provides a centralized interface to manage containers, nodes, secrets, and scheduled tasks across a cluster, with built-in high availability and auto-reconciliation.

## Features

- **Container Management:** Create, start, stop, delete, and monitor Docker containers.
- **Node Clustering:** Register and manage multiple nodes within a cluster.
- **Auto-Reconciliation:** A background service ensures the actual state of containers matches the desired state stored in the database.
- **Scheduled Tasks:** Built-in scheduler for system maintenance (e.g., Restic backups, Volume sync, SSL renewal).
- **Secret Management:** Securely manage environment variables and sensitive data across the cluster.
- **Dynamic Proxying:** Integrated Nginx configuration management for dynamic routing to containers.
- **ETCD Integration:** Uses ETCD as a distributed configuration store for cluster-wide consistency.
- **High Availability Support:** Designed to support VIP (Virtual IP) pools and KeepaliveD for resilient operations.

## Project Structure

- `backend/`: Node.js/Express API server.
  - `services/`: Core logic for Docker interaction, ETCD clustering, reconciliation, and task scheduling.
  - `routes/`: API endpoints for containers, nodes, secrets, tasks, and system info.
- `frontend/`: Next.js dashboard application.
  - `components/`: Modular UI components for managing different aspects of the cluster (Containers, Nodes, Secrets, Tasks, Settings).
  - `pages/`: Application views and API proxying logic.
- `nginx/`: Configuration for the dynamic reverse proxy.

## Getting Started

### Prerequisites

- Docker and Docker Compose installed.
- Access to `/var/run/docker.sock` (the application interacts directly with the Docker daemon).

### Quick Start with Docker Compose

The easiest way to run the entire stack is using Docker Compose:

```bash
docker compose up --build
```

This command builds and starts the backend, frontend, and Nginx proxy containers.

### Accessing the Dashboard

Once the stack is running, you can access the components at:

- **Frontend Dashboard:** [http://localhost:3000](http://localhost:3000)
- **Backend API:** [http://localhost:3001](http://localhost:3001) (Proxied via frontend in dev mode)

## Development

To run the application locally for development:

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Run Backend:**
   ```bash
   npm run backend
   ```

3. **Run Frontend (Development Mode):**
   ```bash
   npm run frontend:dev
   ```

## Security Note

This application requires mounting the Docker socket (`/var/run/docker.sock`). This grants the application full administrative control over your Docker daemon. **Only deploy CoreDocker in secure, trusted, and controlled environments.**

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
