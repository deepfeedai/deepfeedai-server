#!/usr/bin/env bash
# ============================================
# DeepFeedAI — Doctor (Configuration Health Check)
# ============================================
# Validates environment configuration, database connectivity,
# and service availability. Run before or after starting the server.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"

# ── Colors ───────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

PASS=0
FAIL=0
OPTIONAL=0

pass()     { PASS=$((PASS + 1));     echo -e "    ${GREEN}\u2713${NC} $1"; }
fail()     { FAIL=$((FAIL + 1));     echo -e "    ${RED}\u2717${NC} $1"; }
optional() { OPTIONAL=$((OPTIONAL+1)); echo -e "    ${YELLOW}~${NC} $1"; }
info()     { echo -e "    ${CYAN}i${NC} $1"; }

echo ""
echo -e "${BOLD}=== DeepFeed Doctor ===${NC}"
echo ""

# ── Load .env ────────────────────────────────────────────────────
if [ -f "$ENV_FILE" ]; then
  # Source .env (skip comments and export vars)
  set -a
  # shellcheck disable=SC1090
  source <(grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$')
  set +a
  pass ".env file found"
else
  fail ".env file not found at $ENV_FILE"
  info "Run: cp .env.example .env && scripts/setup.sh"
fi

# ── Deployment Mode ──────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}Deployment Mode${NC}"
if [ "${DEPLOYMENT_MODE:-}" = "multi" ]; then
  pass "DEPLOYMENT_MODE=multi (multi-tenant SaaS)"
else
  pass "Single-tenant mode (default)"
  if [ -n "${DEPLOYMENT_MODE:-}" ] && [ "$DEPLOYMENT_MODE" != "multi" ]; then
    info "DEPLOYMENT_MODE='$DEPLOYMENT_MODE' — unrecognized value, treating as single-tenant"
  fi
fi

if [ -n "${INSTANCE_NAME:-}" ]; then
  pass "INSTANCE_NAME=$INSTANCE_NAME"
else
  optional "INSTANCE_NAME not set (will show as 'default')"
fi

# ── Required Config ──────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}Required Config${NC}"
if [ -n "${DATABASE_URL:-}" ]; then
  pass "DATABASE_URL is set"
else
  fail "DATABASE_URL is not set"
fi

if [ -n "${SETTINGS_ENCRYPTION_KEY:-}" ]; then
  KEY_LEN=${#SETTINGS_ENCRYPTION_KEY}
  if [ "$KEY_LEN" -eq 64 ]; then
    pass "SETTINGS_ENCRYPTION_KEY is set (64 chars)"
  else
    fail "SETTINGS_ENCRYPTION_KEY is $KEY_LEN chars (expected 64)"
  fi
else
  optional "SETTINGS_ENCRYPTION_KEY not set (will be auto-generated — save it after first boot)"
fi

if [ -n "${ADMIN_PASSWORD:-}" ]; then
  pass "ADMIN_PASSWORD is set (admin seeded on boot)"
else
  optional "ADMIN_PASSWORD not set (setup wizard will create admin)"
fi

# ── Database ─────────────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}Database${NC}"
if [ -n "${DATABASE_URL:-}" ]; then
  if command -v pg_isready &>/dev/null; then
    if pg_isready -d "$DATABASE_URL" -t 5 &>/dev/null; then
      pass "PostgreSQL reachable"
    else
      fail "PostgreSQL not reachable (pg_isready failed)"
    fi
  elif command -v psql &>/dev/null; then
    if psql "$DATABASE_URL" -c "SELECT 1" &>/dev/null; then
      pass "PostgreSQL reachable"
    else
      fail "PostgreSQL not reachable (psql failed)"
    fi
  else
    optional "Cannot verify DB connectivity (pg_isready/psql not found)"
  fi
else
  fail "Cannot check database — DATABASE_URL not set"
fi

# ── Mode-Specific ────────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}Mode-Specific${NC}"
if [ "${DEPLOYMENT_MODE:-}" = "multi" ]; then
  if [ -n "${TENANT_BASE_DOMAIN:-}" ]; then
    pass "TENANT_BASE_DOMAIN=$TENANT_BASE_DOMAIN"
  else
    fail "Multi-tenant mode but TENANT_BASE_DOMAIN not set — subdomain routing won't work"
  fi
else
  if [ -n "${TENANT_BASE_DOMAIN:-}" ]; then
    optional "TENANT_BASE_DOMAIN is set but ignored in single-tenant mode"
  else
    pass "No TENANT_BASE_DOMAIN needed (single-tenant)"
  fi
fi

# ── Port ─────────────────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}Port${NC}"
APP_PORT="${PORT:-4000}"
if command -v ss &>/dev/null; then
  if ss -tlnp 2>/dev/null | grep -q ":${APP_PORT} "; then
    info "Port $APP_PORT is in use (server may already be running)"
  else
    pass "Port $APP_PORT is available"
  fi
elif command -v lsof &>/dev/null; then
  if lsof -i ":${APP_PORT}" &>/dev/null; then
    info "Port $APP_PORT is in use (server may already be running)"
  else
    pass "Port $APP_PORT is available"
  fi
else
  optional "Cannot check port availability (ss/lsof not found)"
fi

# ── Storage ──────────────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}Storage${NC}"
BACKEND="${STORAGE_BACKEND:-local}"
pass "STORAGE_BACKEND=$BACKEND"
if [ "$BACKEND" = "local" ]; then
  MEDIA_DIR="${STORAGE_LOCAL_DIR:-$PROJECT_DIR/public/media}"
  if [ -d "$MEDIA_DIR" ]; then
    if [ -w "$MEDIA_DIR" ]; then
      pass "Storage directory exists and is writable: $MEDIA_DIR"
    else
      fail "Storage directory exists but is not writable: $MEDIA_DIR"
    fi
  else
    optional "Storage directory does not exist yet: $MEDIA_DIR (will be created on first upload)"
  fi
elif [ "$BACKEND" = "s3" ]; then
  if [ -n "${S3_ENDPOINT:-}" ] && [ -n "${S3_ACCESS_KEY_ID:-}" ] && [ -n "${S3_BUCKET:-}" ]; then
    pass "S3 credentials configured"
  else
    fail "S3 backend selected but missing credentials (S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_BUCKET)"
  fi
fi

# ── Optional Services ────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}Optional Services${NC}"
if [ -n "${GEMINI_API_KEY:-}" ]; then
  pass "GEMINI_API_KEY: configured"
else
  optional "GEMINI_API_KEY: not set (AI summaries disabled unless set in admin UI)"
fi

if [ -n "${RESEND_API_KEY:-}" ]; then
  pass "RESEND_API_KEY: configured"
else
  optional "RESEND_API_KEY: not set (newsletters disabled unless set in admin UI)"
fi

if [ -n "${ELEVENLABS_API_KEY:-}" ]; then
  pass "ELEVENLABS_API_KEY: configured"
else
  optional "ELEVENLABS_API_KEY: not set (audio disabled unless set in admin UI)"
fi

# ── Server Check ─────────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}Server${NC}"
if command -v curl &>/dev/null; then
  INSTANCE_URL="http://localhost:${APP_PORT}/api/instance-info"
  RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "$INSTANCE_URL" 2>/dev/null || echo "000")
  if [ "$RESPONSE" = "200" ]; then
    INSTANCE_DATA=$(curl -s "$INSTANCE_URL" 2>/dev/null)
    pass "Server responding at localhost:${APP_PORT}"
    info "Instance info: $INSTANCE_DATA"
  elif [ "$RESPONSE" = "000" ]; then
    optional "Server not running at localhost:${APP_PORT}"
  else
    optional "Server returned HTTP $RESPONSE at localhost:${APP_PORT}"
  fi
else
  optional "Cannot check server (curl not found)"
fi

# ── Summary ──────────────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}=== ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}, ${YELLOW}$OPTIONAL optional${NC} ${BOLD}===${NC}"
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
