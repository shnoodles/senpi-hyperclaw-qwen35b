#!/usr/bin/env bash
# =============================================================================
# Senpi Agent Fleet Deployer
# =============================================================================
# Deploys multiple Senpi agents on Railway from a single config file.
#
# Usage:
#   bash scripts/deploy-fleet.sh
#
# It will prompt you to select your Railway workspace for each agent.
# Everything else is automatic.
# =============================================================================

set -uo pipefail

CONFIG_FILE="${1:-scripts/fleet-config.json}"
REPO="shnoodles/senpi-hyperclaw-railway-template"

# ── Preflight ──
for cmd in railway jq; do
  command -v "$cmd" &>/dev/null || { echo "❌ $cmd not found"; exit 1; }
done
railway whoami &>/dev/null || { echo "❌ Run: railway login"; exit 1; }
[ -f "$CONFIG_FILE" ] || { echo "❌ $CONFIG_FILE not found"; exit 1; }

AGENT_COUNT=$(jq '.agents | length' "$CONFIG_FILE")
SHARED_SETUP_PASSWORD=$(jq -r '.shared.setup_password // ""' "$CONFIG_FILE")
SHARED_TOGETHER_KEY=$(jq -r '.shared.together_api_key // ""' "$CONFIG_FILE")

echo "🚀 Deploying $AGENT_COUNT agents"
echo ""

for i in $(seq 0 $(($AGENT_COUNT - 1))); do
  AGENT_NAME=$(jq -r ".agents[$i].name" "$CONFIG_FILE")
  AI_PROVIDER=$(jq -r ".agents[$i].ai_provider" "$CONFIG_FILE")
  AI_API_KEY=$(jq -r ".agents[$i].ai_api_key // \"\"" "$CONFIG_FILE")
  MODEL=$(jq -r ".agents[$i].model // \"\"" "$CONFIG_FILE")
  SENPI_AUTH_TOKEN=$(jq -r ".agents[$i].senpi_auth_token" "$CONFIG_FILE")
  TELEGRAM_BOT_TOKEN=$(jq -r ".agents[$i].telegram_bot_token" "$CONFIG_FILE")
  TELEGRAM_USERID=$(jq -r ".agents[$i].telegram_userid // \"\"" "$CONFIG_FILE")

  [ -z "$AI_API_KEY" ] && [ "$AI_PROVIDER" = "together" ] && AI_API_KEY="$SHARED_TOGETHER_KEY"
  SETUP_PASSWORD="${SHARED_SETUP_PASSWORD:-$(openssl rand -hex 16)}"

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "🤖 Agent $((i+1))/$AGENT_COUNT: $AGENT_NAME"
  echo "   Model: $MODEL"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Step 1: Create project (interactive - will ask for workspace)
  echo "   📁 Creating project '$AGENT_NAME'..."
  echo "   👉 Select your workspace when prompted"
  railway init --name "$AGENT_NAME"
  echo ""

  # Step 2: Add GitHub repo as service
  echo "   📦 Adding service from GitHub..."
  railway add -s "$AGENT_NAME" -r "$REPO"

  # Step 3: Link to the new service
  railway service "$AGENT_NAME"

  # Step 4: Volume
  echo "   💾 Adding volume..."
  railway volume add --mount-path "/data" 2>/dev/null || echo "   ⚠️  Volume: check dashboard if needed"

  # Step 5: Set env vars
  echo "   🔧 Setting env vars..."
  railway variables \
    --set "AI_PROVIDER=$AI_PROVIDER" \
    --set "AI_API_KEY=$AI_API_KEY" \
    --set "AI_MODEL=$MODEL" \
    --set "SENPI_AUTH_TOKEN=$SENPI_AUTH_TOKEN" \
    --set "TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN" \
    --set "SETUP_PASSWORD=$SETUP_PASSWORD" \
    --set "OPENCLAW_STATE_DIR=/data/.openclaw" \
    --set "OPENCLAW_WORKSPACE_DIR=/data/workspace" \
    --set "SENPI_STATE_DIR=/data/.openclaw/senpi-state"

  [ -n "$TELEGRAM_USERID" ] && railway variables --set "TELEGRAM_USERID=$TELEGRAM_USERID"

  # Step 6: Domain
  echo "   🌐 Generating domain..."
  railway domain 2>/dev/null || echo "   ⚠️  Domain: enable public networking in dashboard"

  echo ""
  echo "   ✅ $AGENT_NAME done! (password: $SETUP_PASSWORD)"
  echo ""

  # Unlink before next
  railway unlink 2>/dev/null || true
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎉 All $AGENT_COUNT agents deployed!"
echo ""
echo "Send /start to each Telegram bot. Agents boot in ~3-5 min."
echo "Each starts with its own model — no manual switching needed."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
