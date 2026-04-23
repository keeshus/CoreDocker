# Build stage
FROM node:25-alpine AS builder

WORKDIR /app

# Copy root and frontend package files
COPY package*.json ./
COPY frontend/package*.json ./frontend/

# Install dependencies for the frontend workspace
RUN npm install --workspace=@core-docker/frontend

# Copy frontend source
COPY frontend/ ./frontend/

# Build the frontend
RUN npm run build -w @core-docker/frontend

# Production stage
FROM node:25-alpine

# Set production environment
ENV NODE_ENV=production

# Create a non-root user
RUN addgroup -S nodejs && adduser -S nodejs -G nodejs

WORKDIR /app
RUN chown nodejs:nodejs /app

# Copy the frontend workspace package and built assets as the non-root user
COPY --link --from=builder --chown=nodejs:nodejs /app/package.json ./package.json
COPY --link --from=builder --chown=nodejs:nodejs /app/frontend/package.json ./frontend/package.json
COPY --link --from=builder --chown=nodejs:nodejs /app/frontend/.next ./frontend/.next
COPY --link --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules

# Use the non-root user
USER nodejs

EXPOSE 3000

# Run frontend production server using the workspace script
CMD ["npm", "run", "start", "-w", "@core-docker/frontend"]
