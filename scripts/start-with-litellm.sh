#!/bin/bash
# =============================================================================
# Startup script: LiteLLM proxy + OpenClaw gateway
# Place this at: scripts/start-with-litellm.sh
# =============================================================================
set -e

echo "================================================"
echo "  OpenClaw + LiteLLM Vertex AI Proxy Launcher"
echo "================================================"

# ---------------------------------------------------------------------------
# 1. Write Google service account credentials to a file
#    (Railway stores the JSON as a single env var; LiteLLM needs a file path)
# ---------------------------------------------------------------------------
if [ -n "$GOOGLE_CREDENTIALS_JSON" ]; then
  echo "$GOOGLE_CREDENTIALS_JSON" > /tmp/gcp-sa-key.json
  export GOOGLE_APPLICATION_CREDENTIALS="/tmp/gcp-sa-key.json"
  echo "[✓] Google service account credentials written to /tmp/gcp-sa-key.json"
else
  echo "[!] WARNING: GOOGLE_CREDENTIALS_JSON is not set."
  echo "    LiteLLM will not be able to authenticate with Vertex AI."
  echo "    Set this env var to your service account JSON contents."
fi

# ---------------------------------------------------------------------------
# 2. Inject project/location into litellm config if env vars are set
# ---------------------------------------------------------------------------
LITELLM_CONFIG="/app/litellm_config.yaml"

if [ -n "$GCP_PROJECT_ID" ]; then
  sed -i "s/YOUR_GCP_PROJECT_ID/${GCP_PROJECT_ID}/g" "$LITELLM_CONFIG"
  echo "[✓] GCP project ID set to: $GCP_PROJECT_ID"
fi

if [ -n "$GCP_REGION" ]; then
  sed -i "s/vertex_location: REGION/vertex_location: ${GCP_REGION}/g" "$LITELLM_CONFIG"
  echo "[✓] GCP region set to: $GCP_REGION"
fi

# ---------------------------------------------------------------------------
# 3. Set LiteLLM master key (used by OpenClaw to authenticate to the proxy)
# ---------------------------------------------------------------------------
export LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY:-sk-litellm-$(head -c 16 /dev/urandom | xxd -p)}"
echo "[✓] LiteLLM master key configured"

# ---------------------------------------------------------------------------
# 4. Start LiteLLM proxy in the background on port 4000
# ---------------------------------------------------------------------------
echo "[→] Starting LiteLLM proxy on port 4000..."
litellm --config "$LITELLM_CONFIG" --port 4000 --host 0.0.0.0 &
LITELLM_PID=$!

# Wait for LiteLLM to be ready
echo "[→] Waiting for LiteLLM proxy to be ready..."
for i in $(seq 1 30); do
  if curl -s http://localhost:4000/health > /dev/null 2>&1; then
    echo "[✓] LiteLLM proxy is healthy and running (PID: $LITELLM_PID)"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "[✗] LiteLLM proxy failed to start after 30 seconds"
    exit 1
  fi
  sleep 1
done

# ---------------------------------------------------------------------------
# 5. Override AI provider settings to point OpenClaw at the local LiteLLM proxy
# ---------------------------------------------------------------------------
export AI_PROVIDER="${AI_PROVIDER:-openai}"
export AI_API_KEY="$LITELLM_MASTER_KEY"
export AI_BASE_URL="http://localhost:4000"
export AI_MODEL="${AI_MODEL:-qwen3_5-35b}"

echo "[✓] OpenClaw configured to use LiteLLM proxy:"
echo "    Provider:  $AI_PROVIDER"
echo "    Base URL:  $AI_BASE_URL"
echo "    Model:     $AI_MODEL"

# ---------------------------------------------------------------------------
# 6. Start the original OpenClaw entry point
#    (This calls whatever your existing startup script does)
# ---------------------------------------------------------------------------
echo "[→] Starting OpenClaw gateway..."
exec node /app/src/server.js
