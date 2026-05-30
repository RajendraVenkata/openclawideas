#!/usr/bin/env bash
#
# Run an npm script inside a Node sidecar container that shares the
# `openclaw` container's network namespace.
#
# Why: from outside the Docker bridge, the Gateway clears scopes on
# device-less operator connections, so config.patch / channels.start /
# agents.create all fail with `missing scope: operator.read` even after
# a successful hello-ok. By sharing the gateway container's network
# namespace, the bootstrap's WS connection arrives on the Gateway's own
# 127.0.0.1 — the documented "direct-loopback gateway-client backend"
# exception applies, scopes are preserved.
#
# This mirrors the openclaw-cli sidecar pattern from the OpenClaw repo's
# docker-compose.yml (network_mode: "service:openclaw-gateway").
#
# Usage (from openclawideas/bootstrap/):
#
#   ./run-in-sidecar.sh health      # smoke test
#   ./run-in-sidecar.sh bootstrap   # full config bootstrap
#   ./run-in-sidecar.sh watch       # live event stream (adds -it)
#
# Env vars passed through (set them in your host shell before running):
#   OPENCLAW_GATEWAY_TOKEN   required
#   OPENAI_API_KEY           optional, configures OpenAI provider
#   OPENCLAW_DEFAULT_MODEL   optional, defaults to openai/gpt-5.5
#   OPENAI_BASE_URL          optional, e.g. for Azure OpenAI
#   ANTHROPIC_API_KEY        optional, configures Anthropic provider
#   ANTHROPIC_BASE_URL       optional
#   TELEGRAM_BOT_TOKEN       optional, registers Telegram channel
#   TELEGRAM_USER_ID         optional, allowFrom entry for Telegram

set -euo pipefail

SCRIPT="${1:-bootstrap}"
GATEWAY_CONTAINER="${OPENCLAW_GATEWAY_CONTAINER:-openclaw}"
NODE_IMAGE="${OPENCLAW_NODE_IMAGE:-node:24-bookworm-slim}"

if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  echo "✗ OPENCLAW_GATEWAY_TOKEN is not set in this shell." >&2
  echo "  Run: export OPENCLAW_GATEWAY_TOKEN=\"\$(cat ~/.openclaw-secrets/gateway-token)\"" >&2
  exit 1
fi

# `watch` is an interactive stream — give it a TTY.
DOCKER_INTERACTIVE_FLAGS=("--rm")
if [ "$SCRIPT" = "watch" ]; then
  DOCKER_INTERACTIVE_FLAGS+=("-it")
fi

# Verify the gateway container is running so we get a clear error
# instead of a cryptic --network=container:... failure.
if ! docker ps --format '{{.Names}}' | grep -q "^${GATEWAY_CONTAINER}\$"; then
  echo "✗ Gateway container '${GATEWAY_CONTAINER}' is not running." >&2
  echo "  Start it with the docker run from SETUP.md step 4." >&2
  exit 1
fi

# The bootstrap project's package.json uses "file:../../openclaw/packages/sdk"
# for the @openclaw/sdk dependency. From /work inside the sidecar, that path
# resolves to /openclaw/packages/sdk — so we mount the openclaw repo there.
OPENCLAW_REPO="$(cd "$(dirname "$0")/../../openclaw" && pwd)"
if [ ! -f "${OPENCLAW_REPO}/packages/sdk/dist/index.mjs" ]; then
  echo "✗ @openclaw/sdk not built at ${OPENCLAW_REPO}/packages/sdk/dist/" >&2
  echo "  Build it once with: cd ${OPENCLAW_REPO}/packages/sdk && pnpm build" >&2
  exit 1
fi

# Use a named docker volume for the sidecar's node_modules so:
#  (a) host-installed darwin binaries don't conflict with the Linux sidecar
#  (b) `npm install` only runs the first time; later runs reuse the volume
SIDECAR_DEPS_VOLUME="${OPENCLAW_SIDECAR_DEPS_VOLUME:-openclaw-bootstrap-deps}"

exec docker run "${DOCKER_INTERACTIVE_FLAGS[@]}" \
  --network="container:${GATEWAY_CONTAINER}" \
  -v "$(pwd)":/work \
  -v "${SIDECAR_DEPS_VOLUME}":/work/node_modules \
  -v "${OPENCLAW_REPO}":/openclaw:ro \
  -w /work \
  -e OPENCLAW_GATEWAY_URL="ws://127.0.0.1:18789" \
  -e OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN}" \
  -e OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
  -e OPENAI_BASE_URL="${OPENAI_BASE_URL:-}" \
  -e OPENCLAW_DEFAULT_MODEL="${OPENCLAW_DEFAULT_MODEL:-openai/gpt-5.5}" \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  -e ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-}" \
  -e TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}" \
  -e TELEGRAM_USER_ID="${TELEGRAM_USER_ID:-}" \
  "${NODE_IMAGE}" \
  sh -c "npm install --no-audit --no-fund --silent --no-package-lock && npm run ${SCRIPT}"
