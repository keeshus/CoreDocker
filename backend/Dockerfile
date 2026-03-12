FROM node:25-alpine

WORKDIR /app

# Copy package.json from root
COPY package*.json ./
RUN npm install

# Copy everything
COPY . .

EXPOSE 3000

# Run backend
CMD ["node", "backend/index.js"]
