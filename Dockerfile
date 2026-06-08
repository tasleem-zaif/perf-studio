# ─────────────────────────────────────────────────────────────────────────────
# PerfStudio — All-in-one Docker image
#
# Contains:
#   • Node.js 20        (backend API + frontend SSR)
#   • Java 17 (OpenJDK) (required by JMeter)
#   • Apache JMeter 5.6.3 + plugins (jpgc-casutg)
#   • K6 v0.52          (load test engine)
#   • Git               (Git integration feature)
#
# Build:
#   docker build -t perfstudio:latest .
#
# Run:
#   docker run -d -p 3001:3001 -v perfstudio_data:/app/data perfstudio:latest
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Build the React frontend ────────────────────────────────────────
FROM node:22-slim AS frontend-builder

WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build
# Output: /build/frontend/dist


# ── Stage 2: Final runtime image ─────────────────────────────────────────────
FROM ubuntu:22.04

LABEL maintainer="Quarks Technosoft <info@qtsolv.com>"
LABEL description="PerfStudio — AI-Powered Performance Testing Platform"

# Prevent interactive prompts during apt installs
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

# ── Base packages ─────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    git \
    unzip \
    ca-certificates \
    gnupg2 \
    apt-transport-https \
    software-properties-common \
    fontconfig \
    libfreetype6 \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

# ── Java 17 (required by JMeter) ──────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-17-jdk-headless \
    && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV PATH=$PATH:$JAVA_HOME/bin

# ── Apache JMeter 5.6.3 ───────────────────────────────────────────────────────
ARG JMETER_VERSION=5.6.3
ARG JMETER_MIRROR=https://archive.apache.org/dist/jmeter/binaries

RUN wget -q "${JMETER_MIRROR}/apache-jmeter-${JMETER_VERSION}.tgz" -O /tmp/jmeter.tgz \
    && mkdir -p /opt/jmeter \
    && tar -xzf /tmp/jmeter.tgz -C /opt/ \
    && mv /opt/apache-jmeter-${JMETER_VERSION}/* /opt/jmeter/ \
    && rm -rf /tmp/jmeter.tgz /opt/apache-jmeter-${JMETER_VERSION}

ENV JMETER_HOME=/opt/jmeter
ENV PATH=$PATH:/opt/jmeter/bin

# ── JMeter Plugins: Custom Thread Groups (jpgc-casutg) ───────────────────────
# Required for Stress / Spike / Endurance / Concurrency thread group types
RUN wget -q "https://jmeter-plugins.org/files/packages/jpgc-casutg-2.10.zip" -O /tmp/jpgc-casutg.zip \
    && unzip -o /tmp/jpgc-casutg.zip -d /opt/jmeter \
    && rm /tmp/jpgc-casutg.zip \
    # Also install the Plugin Manager JAR so future plugins can be added easily
    && wget -q "https://jmeter-plugins.org/get/" -O /opt/jmeter/lib/ext/jmeter-plugins-manager.jar || true

# ── K6 ────────────────────────────────────────────────────────────────────────
RUN curl -fsSL https://dl.k6.io/key.gpg | gpg --dearmor -o /usr/share/keyrings/k6-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
       > /etc/apt/sources.list.d/k6.list \
    && apt-get update \
    && apt-get install -y k6 \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 20 ────────────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── Verify all tools are available ───────────────────────────────────────────
RUN java -version && jmeter --version && k6 version && node --version && git --version

# ── Application setup ─────────────────────────────────────────────────────────
WORKDIR /app

# Install backend Node dependencies (production only)
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev

# Copy backend source
COPY backend/src ./backend/src

# Copy built frontend from Stage 1 → served as static files by backend
COPY --from=frontend-builder /build/frontend/dist ./backend/public

# ── Data directories (mounted as volumes in production) ───────────────────────
RUN mkdir -p /app/data /app/projects /app/git-workspaces /app/backups

# ── Environment defaults (override via -e or .env) ───────────────────────────
ENV NODE_ENV=production
ENV PORT=3001
ENV DB_PATH=/app/data/perf_studio.db
ENV PROJECTS_ROOT=/app/projects
ENV BACKUPS_ROOT=/app/backups
# Paths picked up automatically by execution.js
ENV JMETER_BIN=/opt/jmeter/bin/jmeter
ENV K6_BIN=/usr/bin/k6

EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3001/api/health || exit 1

CMD ["node", "backend/src/index.js"]
