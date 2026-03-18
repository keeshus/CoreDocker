# Build stage
FROM node:25-alpine AS builder

WORKDIR /app

# Copy package.json from root
COPY package*.json ./
RUN npm install

# Copy everything
COPY . .

# Production stage
FROM node:25-alpine

WORKDIR /app

# Copy only the backend and shared infra
COPY --from=builder /app/backend ./backend
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3000

# Run backend
CMD ["node", "backend/index.js"]
