# ── PerfStudio Backend ─────────────────────────────────────────────────────────
# Lightweight Node.js container. JMeter and K6 are NOT installed here —
# they run in their own Docker containers (justb4/jmeter, grafana/k6) spawned
# by this service via the Docker socket at runtime.
# ──────────────────────────────────────────────────────────────────────────────
FROM node:18-alpine

# wget for health-check, curl for diagnostics
RUN apk add --no-cache wget curl

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source
COPY src/ ./src/
COPY docker-entrypoint.sh ./
RUN chmod +x ./docker-entrypoint.sh

# Ensure data directories exist
RUN mkdir -p /app/data /data/projects /data/backups

# ── Security: run as non-root user ──────────────────────────────────────────
RUN addgroup -S perfstudio && adduser -S -G perfstudio -u 1001 perfstudio
RUN chown -R perfstudio:perfstudio /app /data
USER perfstudio

EXPOSE 3001

ENTRYPOINT ["./docker-entrypoint.sh"]
