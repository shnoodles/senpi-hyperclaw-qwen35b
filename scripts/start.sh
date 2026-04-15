#!/bin/bash
# =============================================================================
# Startup script: OpenClaw gateway (direct Vercel AI Gateway)
# =============================================================================
set -e

echo "================================================"
echo "  OpenClaw Gateway Launcher"
echo "================================================"

# ---------------------------------------------------------------------------
# 1. Vercel AI Gateway configuration
# ---------------------------------------------------------------------------
export VERCEL_AI_GATEWAY_URL="${VERCEL_AI_GATEWAY_URL:-https://ai-gateway.vercel.sh/v1}"
echo "[✓] Vercel AI Gateway URL: $VERCEL_AI_GATEWAY_URL"

if [ -n "$VERCEL_API_KEY" ]; then
  echo "[✓] Vercel API key is set"
else
  echo "[!] VERCEL_API_KEY is not set (Vercel AI Gateway will not work without it)"
fi

# ---------------------------------------------------------------------------
# 2. Set env vars for auto-onboard
# ---------------------------------------------------------------------------
export AI_PROVIDER="${AI_PROVIDER:-vercel-ai-gateway}"
export AI_API_KEY="${AI_API_KEY:-$VERCEL_API_KEY}"
export AI_MODEL="${AI_MODEL:-google/gemma-4-31b-it}"

echo "[✓] OpenClaw AI env vars set:"
echo "    Provider:  $AI_PROVIDER"
echo "    Model:     $AI_MODEL"

# ---------------------------------------------------------------------------
# 3. Start the OpenClaw entry point
# ---------------------------------------------------------------------------
echo "[→] Starting OpenClaw gateway..."
exec node /app/src/server.js
