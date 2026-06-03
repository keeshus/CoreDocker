# Build stage
FROM node:25-alpine AS builder

WORKDIR /app

# Copy root and backend package files
COPY package*.json ./
COPY backend/package*.json ./backend/

# Install only production dependencies for the backend workspace
RUN npm install --workspace=@core-docker/backend --omit=dev

# Copy backend source
COPY backend/ ./backend/

# Production stage
FROM node:25-alpine

# Set production environment
ENV NODE_ENV=production

WORKDIR /app

# Create a non-root user
RUN addgroup -S nodejs && adduser -S nodejs -G nodejs

WORKDIR /app
RUN chown nodejs:nodejs /app

# Copy the workspace-specific dependencies and source
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/backend ./backend
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./package.json

# Create data directory with correct ownership
RUN mkdir -p /app/data && chown nodejs:nodejs /app/data

# Entrypoint creates mount subdirectories as root, then drops to nodejs
COPY backend/entrypoint.sh /app/entrypoint.sh
ENTRYPOINT ["/app/entrypoint.sh"]

EXPOSE 3000

# Health check using BusyBox wget (available in node:alpine)
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:3000/api/health || exit 1

# The entrypoint runs as root to create mount directories, then drops
# to nodejs via su-exec. Do NOT set USER here — it would prevent the
# entrypoint from creating directories in bind-mounted volumes.
CMD ["node", "backend/index.js"]
