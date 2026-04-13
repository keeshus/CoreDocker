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

WORKDIR /app

# Create a non-root user
RUN addgroup -S nodejs && adduser -S nodejs -G nodejs

# Copy the frontend workspace package and built assets
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/frontend/package.json ./frontend/package.json
COPY --from=builder /app/frontend/.next ./frontend/.next
COPY --from=builder /app/node_modules ./node_modules

# Ensure permissions are correct for Next.js cache if needed, but normally .next is read-only in prod
RUN chown -R nodejs:nodejs /app

# Use the non-root user
USER nodejs

EXPOSE 3000

# Run frontend production server using the workspace script
CMD ["npm", "run", "start", "-w", "@core-docker/frontend"]
