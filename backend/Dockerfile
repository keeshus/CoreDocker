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

# Copy the workspace-specific dependencies and source
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend ./backend
COPY --from=builder /app/package.json ./package.json

# Create data directory and set permissions
RUN mkdir -p /app/data && chown -R nodejs:nodejs /app/data /app/backend /app/node_modules

# Use the non-root user
USER nodejs

EXPOSE 3000

# Run backend from the workspace
CMD ["node", "backend/index.js"]
