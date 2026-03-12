# Docker Management App

A consolidated full-stack application to interact with and visualize the Docker daemon via the Docker socket.

## Project Structure

- `package.json`: Root package configuration for both frontend and backend.
- `/backend`: Node.js/Express server logic.
- `/frontend`: Next.js dashboard logic.

## How to Run

### 1. Start the Stack with Docker Compose

This is the recommended way as it handles networking and the Docker socket mount.

```bash
docker compose up --build
```

### 2. Access the Application

- **Frontend:** [http://localhost:3000](http://localhost:3000)
- **Backend API:** [http://localhost:3001](http://localhost:3001)

## Development

If you wish to run locally (ensure you have access to `/var/run/docker.sock`):

1. Install dependencies: `npm install`
2. Run Backend: `npm run backend`
3. Run Frontend: `npm run frontend:dev`

## Security Note

This app mounts `/var/run/docker.sock`. This provides the container with full administrative access to your Docker daemon. Use only in a secure, controlled environment.
