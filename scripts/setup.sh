#!/usr/bin/env bash
set -euo pipefail

# ============================================
# DeepFeedAI Admin — Setup Script
# ============================================
# Generates .env with random secrets for a self-hosted deployment.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"
ENV_EXAMPLE="$PROJECT_DIR/.env.example"

echo "=== DeepFeedAI Admin Setup ==="
echo ""

# Step 1: Copy .env.example if .env doesn't exist
if [ -f "$ENV_FILE" ]; then
  echo ".env already exists. Remove it first if you want to start fresh."
  exit 1
fi

if [ ! -f "$ENV_EXAMPLE" ]; then
  echo "Error: .env.example not found at $ENV_EXAMPLE"
  exit 1
fi

cp "$ENV_EXAMPLE" "$ENV_FILE"
echo "Created .env from .env.example"

# Step 2: Generate random secrets
# Note: JWT_SECRET, USER_JWT_SECRET, and CRON_SECRET are optional.
# If not set, they are auto-generated and stored encrypted in the settings table.
# Setting them here gives explicit control and avoids the first-run auto-generation.
JWT_SECRET=$(openssl rand -base64 48)
USER_JWT_SECRET=$(openssl rand -base64 48)
CRON_SECRET=$(openssl rand -base64 32)
SETTINGS_ENCRYPTION_KEY=$(openssl rand -hex 32)

# Step 3: Write secrets into .env
# Use | as sed delimiter to avoid conflicts with base64 characters
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|" "$ENV_FILE"
sed -i "s|^USER_JWT_SECRET=.*|USER_JWT_SECRET=$USER_JWT_SECRET|" "$ENV_FILE"
sed -i "s|^CRON_SECRET=.*|CRON_SECRET=$CRON_SECRET|" "$ENV_FILE"
sed -i "s|^SETTINGS_ENCRYPTION_KEY=.*|SETTINGS_ENCRYPTION_KEY=$SETTINGS_ENCRYPTION_KEY|" "$ENV_FILE"

# Step 4: Set storage backend (single-tenant is now the default — no env var needed)
sed -i "s|^# STORAGE_BACKEND=local|STORAGE_BACKEND=local|" "$ENV_FILE"
sed -i "s|^# STORAGE_LOCAL_DIR=.*|STORAGE_LOCAL_DIR=./public/media|" "$ENV_FILE"

# Summary
echo ""
echo "=== Setup Complete ==="
echo ""
echo "  Deployment mode:  single-tenant (default)"
echo "  Storage backend:  local (./public/media)"
echo "  JWT secrets:      generated"
echo "  Encryption key:   generated"
echo "  Cron secret:      generated"
echo ""
echo "Next steps:"
echo "  1. Set DATABASE_URL in .env to your PostgreSQL connection string"
echo "  2. Run: docker compose up -d"
echo "  3. Open http://localhost:4000"
echo ""
