# Build stage
FROM node:25-alpine AS builder

WORKDIR /app

# Copy package.json from root
COPY package*.json ./
RUN npm install

# Copy everything and build
COPY . .
RUN npm run frontend:build

# Production stage
FROM node:25-alpine

WORKDIR /app

# Copy built frontend assets
COPY --from=builder /app/frontend/.next ./frontend/.next
# Removed explicit copy of public since it might be empty or missing in this project structure
# Assets should be bundled in .next if configured or we can add it back if needed

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3000

# Run frontend production server
CMD ["npm", "run", "frontend:start"]
