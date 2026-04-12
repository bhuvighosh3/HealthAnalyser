FROM node:20-slim

# Native build tools needed for sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
# Copy postinstall script before npm ci so it exists when npm runs it
COPY scripts/ ./scripts/
RUN npm ci --omit=dev && npm rebuild sqlite3 --build-from-source

# Copy source
COPY . .

# Cloud Run injects PORT; default to 8080
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
