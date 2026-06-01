# ── PerfStudio Backend ─────────────────────────────────────────────────────────
# Lightweight Node.js container. JMeter and K6 are NOT installed here —
# they run in their own Docker containers (justb4/jmeter, grafana/k6) spawned
# by this service via the Docker socket at runtime.
# ──────────────────────────────────────────────────────────────────────────────
FROM node:18-alpine

# wget is used by the health-check probe; curl for optional diagnostics
RUN apk add --no-cache wget curl

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source
COPY src/ ./src/

# Ensure all required data directories exist at startup
RUN mkdir -p /app/data /data/projects /data/backups

EXPOSE 3001

CMD ["node", "src/index.js"]
