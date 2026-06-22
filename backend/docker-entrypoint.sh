#!/bin/sh
# ── Peako Backend — Container Entrypoint ─────────────────────────────────
# Runs once at container start: ensures data directories exist, then starts app.
# ──────────────────────────────────────────────────────────────────────────────

set -e

echo "╔══════════════════════════════════════════════╗"
echo "║       Performance Studio — Starting          ║"
echo "╚══════════════════════════════════════════════╝"

# ── Ensure required directories exist ─────────────────────────────────────────
echo "[entrypoint] Ensuring data directories exist..."
mkdir -p /app/data
mkdir -p /data/projects
mkdir -p /data/backups

echo "[entrypoint] Data directories ready."

# ── Start the application ──────────────────────────────────────────────────────
echo "[entrypoint] Starting Node.js server..."
exec node src/index.js
