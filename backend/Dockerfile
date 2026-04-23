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
COPY --link --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --link --from=builder --chown=nodejs:nodejs /app/backend ./backend
COPY --link --from=builder --chown=nodejs:nodejs /app/package.json ./package.json

# Create data directory and set permissions
RUN mkdir -p /app/data && chown nodejs:nodejs /app/data

# Use the non-root user
USER nodejs

EXPOSE 3000

# Run backend from the workspace
CMD ["node", "backend/index.js"]
