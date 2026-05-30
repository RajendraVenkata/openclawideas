# SETUP — From Zero to a Working OpenClaw + OpenAI Bootstrap

A linear, copy-pasteable walkthrough that takes you from "nothing running" to "OpenAI key configured, model picked, Gateway responding to chat" — entirely over WebSocket, no `openclaw onboard`, no Control UI clicks.

Estimated time: **10–15 minutes** (excluding the first Docker build, which can take 10–25 minutes depending on your connection).

---

## What you'll have at the end

- An OpenClaw Gateway running in a Docker container, started **unconfigured** with `--allow-unconfigured`.
- A persistent gateway auth token (`OPENCLAW_GATEWAY_TOKEN`) that you'll keep using for every WS connection.
- OpenAI configured as the model provider via WebSocket — no CLI touched the container, no browser opened.
- A snapshot of all running channels, agents, and models, confirmed live.
- A working TypeScript project you can extend to add channels, agents, cron, bindings, etc.

---

## Prerequisites

| Tool | Why | Check |
|---|---|---|
| Docker Engine or Docker Desktop | runs the Gateway container | `docker --version` |
| Node.js 22+ | runs the bootstrap script | `node --version` |
| `openssl` | generates the gateway token | `openssl version` |
| `curl` | quick HTTP health checks | `curl --version` |
| An OpenAI API key | what we'll plug into the Gateway | from <https://platform.openai.com/api-keys> |

If you're on Mac: Docker Desktop is the simplest. Bump its memory to **at least 4 GB** under Settings → Resources → Memory (the OpenClaw build is hungry).

---

## Step 1 — Get the OpenClaw image

**Option A — Use the official image (skip the build entirely):**

```bash
docker pull ghcr.io/openclaw/openclaw:latest
docker tag ghcr.io/openclaw/openclaw:latest openclaw:local
```

**Option B — Build it yourself:**

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
DOCKER_BUILDKIT=1 docker build -t openclaw:local .
```

The build can take 10–25 minutes the first time. If it fails on npm registry timeouts, see `../ISSUES.md` § Issue #1 — the short version is `add timeout values to .npmrc and retry; BuildKit's pnpm-store cache makes each retry shorter than the last`.

Verify the image:

```bash
docker images openclaw:local
docker run --rm openclaw:local node openclaw.mjs --version
```

---

## Step 2 — Create `OPENCLAW_GATEWAY_TOKEN`

The token is a shared secret that every WS connection presents during the handshake. Generate a strong random one and save it — you'll use the same value for the container env var **and** for every script that connects later.

```bash
# Generate
TOKEN="$(openssl rand -hex 32)"
echo "$TOKEN"
```

Example output:
```
9c1ad07f6e0ec8a5ce20b2f6acdcdee7c7c0a73f7b8f6c43a2a6df7bb6e9d432
```

**Save it somewhere persistent.** Once the container's running, you can't recover the value from inside the container — it only exists as an env var that you supplied.

A simple persistent option for local dev:

```bash
mkdir -p ~/.openclaw-secrets
chmod 700 ~/.openclaw-secrets
echo "$TOKEN" > ~/.openclaw-secrets/gateway-token
chmod 600 ~/.openclaw-secrets/gateway-token
```

To re-read it later:

```bash
TOKEN="$(cat ~/.openclaw-secrets/gateway-token)"
```

PowerShell equivalent:

```powershell
$TOKEN = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
$secretDir = "$HOME\.openclaw-secrets"
New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
$TOKEN | Set-Content -Path "$secretDir\gateway-token" -Encoding ASCII
$TOKEN
```

---

## Step 3 — Prepare host directories for container state

The container runs as `node` (uid 1000). Pre-create the volume directories so Docker doesn't make them root-owned on first start.

Note the layout: **`workspace/` lives inside `state/`** on the host. The container's `/home/node/.openclaw/workspace` path is nested inside `/home/node/.openclaw`, and the host layout has to mirror that. If you create them as separate sibling directories, Docker will fail with a `permission denied` mountpoint error when starting the container (see [troubleshooting](#troubleshooting-quick-reference) and `../ISSUES.md`).

```bash
mkdir -p ~/openclaw-docker/state/workspace
mkdir -p ~/openclaw-docker/auth-profile-secrets
```

### macOS: do NOT chown

Docker Desktop on macOS uses virtiofs to translate host file ownership into the container automatically. Manually `chown`-ing the host directory to uid 1000 actually **breaks** that translation — the host user can't write to it and the container's `node` user can't either. Skip the chown on Mac.

### Linux native Docker: chown to uid 1000

On Linux, the container's `node` user (uid 1000) needs to own the host directories so it can write into them:

```bash
# Linux ONLY
sudo chown -R 1000:1000 ~/openclaw-docker
```

If you accidentally ran this on macOS, recover with `sudo chmod -R 777 ~/openclaw-docker` (and see Issue #3 in `../ISSUES.md` for the full story).

Resulting host layout:

```
~/openclaw-docker/
├── state/                       <-- mounts to /home/node/.openclaw
│   └── workspace/               <-- exposed at /home/node/.openclaw/workspace
└── auth-profile-secrets/        <-- mounts to /home/node/.config/openclaw
```

---

## Step 4 — Run the container unconfigured

```bash
docker run -d \
  --name openclaw \
  --restart unless-stopped \
  --init \
  --cap-drop NET_RAW --cap-drop NET_ADMIN \
  --security-opt no-new-privileges:true \
  --add-host host.docker.internal:host-gateway \
  -e HOME=/home/node \
  -e OPENCLAW_HOME=/home/node \
  -e OPENCLAW_STATE_DIR=/home/node/.openclaw \
  -e OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json \
  -e OPENCLAW_CONFIG_DIR=/home/node/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/workspace \
  -e OPENCLAW_GATEWAY_TOKEN="$TOKEN" \
  -e TZ=UTC \
  -v ~/openclaw-docker/state:/home/node/.openclaw \
  -v ~/openclaw-docker/auth-profile-secrets:/home/node/.config/openclaw \
  -p 127.0.0.1:18789:18789 \
  openclaw:local \
  node openclaw.mjs gateway \
    --allow-unconfigured \
    --bind lan \
    --port 18789
```

Four things to know:
- `--allow-unconfigured` is the documented flag that lets the Gateway start with no `openclaw.json` (`src/cli/gateway-run-argv.ts:18`).
- `--bind lan` is required because we use `-p 127.0.0.1:18789:18789` (bridge networking). Without it the Gateway binds container-loopback and is unreachable from the host. The doc warning in the Dockerfile (lines 313–321) spells this out.
- The token is **mandatory** for non-loopback bind. The Gateway refuses to start without one (*"refusing to bind gateway ... without auth"*).
- Only **two** bind mounts. The workspace lives inside `state/` on the host, so it's exposed automatically through the state mount at `/home/node/.openclaw/workspace`. Mounting workspace separately into a nested container path triggers a runc `mkdirat ... permission denied` on Docker Desktop. The OpenClaw compose file uses nested host paths to avoid the same trap.

---

## Step 5 — Verify the container is up

```bash
# Container running?
docker ps --filter name=openclaw --format 'table {{.Names}}\t{{.Status}}'

# Built-in HTTP probes (no auth needed)
curl -fsS http://127.0.0.1:18789/healthz
curl -fsS http://127.0.0.1:18789/readyz
```

Expected output:
```json
{"ok":true,"status":"live"}
{"ready":true}
```

If you see those, the Gateway process is alive and accepting traffic. The `/healthz` and `/readyz` endpoints are built into the image's HEALTHCHECK (`Dockerfile:322`) and require no auth.

---

## Step 6 — Get the bootstrap project

You're reading this file inside `openclawideas/bootstrap/`. From your terminal:

```bash
cd /Users/rajendra/projects/openclaw/openclawideas/bootstrap

# Install (only need to do this once)
npm install
```

`npm install` brings in `ws`, `tsx`, TypeScript, and types — no other dependencies.

---

## Step 7 — Get an OpenAI API key

1. Open <https://platform.openai.com/api-keys>.
2. Sign in or create an account.
3. Click **"Create new secret key"**.
4. Give it a name like `openclaw-local`.
5. Copy the key (it'll only be shown once — starts with `sk-...`).

Test it works:

```bash
curl -fsS https://api.openai.com/v1/models \
  -H "Authorization: Bearer sk-..." \
  | head -c 200
```

You should see JSON listing your available models. If you get `401 Unauthorized`, the key is wrong — regenerate.

---

## Step 7.5 — Seed the device-auth override

The bootstrap script connects from your Mac through Docker's port-forwarder. From inside the container, that connection arrives on the Docker bridge interface — **not loopback** — so the "trusted same-process backend client" exception doesn't apply. The Gateway clears your declared scopes to `[]` and scope-gated RPCs fail with `missing scope: operator.read`.

The documented escape hatch is `gateway.controlUi.dangerouslyDisableDeviceAuth: true`. It preserves declared scopes for device-less operator connections.

> **Tradeoff:** anyone with your `OPENCLAW_GATEWAY_TOKEN` gets full operator scope. Since the container is bound to `127.0.0.1` and your token lives only on your Mac, the practical exposure is no worse than a leaked API key. For production deployments with non-loopback bind, use real device pairing instead — see `../openclaw-gateway-websocket-setup.md` § Pairing.

Always write this file from **inside the container** to avoid host-side permission issues (especially on macOS where Docker Desktop's uid translation can fight you):

```bash
docker exec -i openclaw sh -c 'cat > /home/node/.openclaw/openclaw.json' <<'EOF'
{
  "gateway": {
    "controlUi": {
      "dangerouslyDisableDeviceAuth": true
    }
  }
}
EOF

# Verify it landed
docker exec openclaw cat /home/node/.openclaw/openclaw.json

# Restart so the Gateway picks up the new config on startup
docker restart openclaw

# Confirm it's healthy
sleep 5
curl -fsS http://127.0.0.1:18789/healthz
```

If you get `sh: cannot create ...: Permission denied`, your host directory perms are blocking the bind-mounted write. Fix with `sudo chmod -R 777 ~/openclaw-docker` and retry.

---

## Step 8 — Create `.env`

In `openclawideas/bootstrap/`, copy the example and fill in your values:

```bash
cp .env.example .env
```

Then edit `.env` so it contains at minimum:

```bash
OPENCLAW_GATEWAY_TOKEN=<paste your token from step 2>
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
OPENAI_API_KEY=sk-...
OPENCLAW_DEFAULT_MODEL=openai/gpt-5.5
```

Notes:
- `OPENCLAW_GATEWAY_TOKEN` must be **exactly** the same value you passed to `docker run` in step 4.
- `OPENCLAW_DEFAULT_MODEL` is optional. If you leave it blank, bootstrap picks `openai/gpt-5.5` when OpenAI is set, or `anthropic/claude-sonnet-4-6` when Anthropic is set.

The `.gitignore` blocks `.env` from being committed.

---

## Step 9 — Load `.env` into your shell

`bootstrap` deliberately doesn't depend on `dotenv` — load `.env` into your shell environment with one of these:

**bash / zsh:**
```bash
set -a
source .env
set +a
```

**fish:**
```fish
for line in (cat .env | grep -v '^#' | grep -v '^$')
    set parts (string split -m1 = $line)
    set -gx $parts[1] $parts[2]
end
```

**PowerShell:**
```powershell
Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*([^#=][^=]*)=(.*)$') {
    [Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2].Trim())
  }
}
```

Quick check the env vars made it in:

```bash
echo "TOKEN length: ${#OPENCLAW_GATEWAY_TOKEN}"  # bash; should be 64
echo "OPENAI key prefix: ${OPENAI_API_KEY:0:7}"  # bash; should print "sk-..."
```

---

## Step 10 — Smoke test: `npm run health`

This is the simplest possible WS round-trip. It connects, completes the handshake, calls `health`, and exits.

```bash
npm run health
```

Expected output:

```
→ connecting to ws://127.0.0.1:18789
✓ hello-ok
  server.version  : 2026.x.x
  server.connId   : <uuid>
  protocol        : 4
  negotiated role : operator
  negotiated scope: operator.admin, operator.read, operator.write, operator.pairing, operator.approvals
  policy          : maxPayload=26214400  tick=15000ms

→ rpc: health
✓ health: { ... }
```

If you got this, your Gateway is reachable, your token is right, and the WS handshake is working. You're ready to configure it.

If you got `Gateway error: AUTH_TOKEN_MISMATCH` → check `OPENCLAW_GATEWAY_TOKEN` matches the one you passed to `docker run` exactly (no trailing newline). Re-read it: `cat ~/.openclaw-secrets/gateway-token`.

If you got `timeout waiting for connect.challenge` → the container isn't reachable. Check `curl http://127.0.0.1:18789/healthz`. If that fails too, check `docker ps` and the container logs (`docker logs openclaw`).

---

## Step 11 — Configure the Gateway: `npm run bootstrap`

```bash
npm run bootstrap
```

This walks through:

1. Connect + hello-ok
2. `health`
3. `models.list` (snapshot before)
4. `channels.status` (snapshot before)
5. `agents.list` (snapshot before)
6. **`config.patch` — OpenAI provider + default model + workspace + DM session scope**
7. `models.list` (configured) — proves the model resolved
8. `models.authStatus` — proves the provider auth worked
9. *(Skipped — no Telegram envs set yet)*
10. `channels.status` (final snapshot)
11. `agents.list` (final snapshot)

What you should see for step 6 (the one that does the actual work):

```
→ config.patch — openai provider + default model
✓ {
  "ok": true,
  ...
}
```

For step 8 (`models.authStatus`):

```
→ models.authStatus
✓ {
  "openai": { "status": "ok", ... }
}
```

That's your confirmation that OpenAI is hooked up and reachable.

---

## Step 12 — Verify the config persisted

The container has a bind-mounted state directory (`~/openclaw-docker/state`), so `openclaw.json` is now sitting on your host filesystem. The workspace, sessions, and credentials directories all live inside it too:

```bash
ls -la ~/openclaw-docker/state/
cat ~/openclaw-docker/state/openclaw.json
```

You should see something like:

```json5
{
  "models": {
    "providers": {
      "openai": { "apiKey": "sk-..." }
    }
  },
  "agents": {
    "defaults": {
      "workspace": "/home/node/.openclaw/workspace",
      "model": "openai/gpt-5.5"
    }
  },
  "session": { "dmScope": "per-channel-peer" }
}
```

Restart the container — config survives because of the volume:

```bash
docker restart openclaw

# Wait a few seconds, then re-verify
curl -fsS http://127.0.0.1:18789/healthz
npm run health
```

---

## Step 13 — (Optional) Verify by asking the agent something

Add a minimal "ask the agent" call to confirm OpenAI actually responds. From `openclawideas/bootstrap/`, create a one-off script:

```bash
cat > src/ask.ts <<'EOF'
import { GatewayClient, readEnv } from "./client.js";

async function main() {
  const { url, token } = readEnv();
  const c = new GatewayClient({ url, token });
  await c.connect();
  const r: any = await c.rpc("agent", {
    input: "In one sentence, what is OpenClaw?",
    sessionKey: "main",
    timeoutMs: 60000,
    deliver: false,
  });
  console.log("accepted:", r);

  // Two-stage: wait for terminal
  const final = await c.rpc("agent.wait", {
    runId: (r as { runId: string }).runId,
    timeoutMs: 90000,
  });
  console.log("final:", JSON.stringify(final, null, 2));
  await c.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
EOF

npx tsx src/ask.ts
```

If OpenAI is wired up correctly, you'll see a one-sentence answer in the final payload.

---

## Step 14 — What to do next

You now have a working configured Gateway. Common next steps:

| Goal | Command / file |
|---|---|
| Add a Telegram bot | Set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_USER_ID` in `.env`, re-run `npm run bootstrap`. The script picks up the new envs and configures Telegram. |
| Add WhatsApp | See `../openclaw-channels-via-websocket.md` § 4 — adds a `web.login.start` / `web.login.wait` QR loop. |
| Add Microsoft Teams | See `../openclaw-msteams-websocket-setup.md` — Azure-side work first, then same WS pattern. |
| Add an isolated per-tenant agent | See `bootstrap.ts` and the "Extending the bootstrap" section in `README.md`. |
| Watch live events | `npm run watch` then trigger something (DM the bot, etc.) |
| Scheduled agent runs | `cron.add` RPC (see `core-descriptors.ts` for the method, and the cron schema in `src/gateway/protocol/schema/`) |

---

## Step 15 — Tearing down (when you're done)

```bash
# Stop the container but keep state on disk
docker stop openclaw

# Or remove the container entirely (state still on host)
docker rm -f openclaw

# Nuclear: wipe all OpenClaw state on this host too
rm -rf ~/openclaw-docker
```

The image (`openclaw:local`) sticks around even after `docker rm` so the next run is fast.

---

## Troubleshooting (quick reference)

| Symptom | Fix |
|---|---|
| `docker run` fails with `mkdirat /var/lib/docker/rootfs/.../workspace: permission denied` | Nested-mount mountpoint missing. `docker rm -f openclaw && mkdir -p ~/openclaw-docker/state/workspace`, then re-run with **two** bind mounts (state + auth-profile-secrets), not three. See step 3 + step 4. |
| `zsh: permission denied` writing to `~/openclaw-docker/state/openclaw.json` | You ran the macOS chown that step 3 used to suggest. Fix: `sudo chmod -R 777 ~/openclaw-docker`, then seed config via `docker exec` (step 7.5). See ISSUES.md #3. |
| `sh: cannot create /home/node/.openclaw/openclaw.json: Permission denied` (inside container) | Same root cause as the previous row. `sudo chmod -R 777 ~/openclaw-docker` and retry the `docker exec` write. |
| RPC fails with `missing scope: operator.read` even after `hello-ok` | Declared scopes were cleared because connection isn't loopback. You skipped step 7.5 — seed the `dangerouslyDisableDeviceAuth: true` config and restart the container. |
| `scopes negotiated:` line is empty in `npm run health` | Same as above — see step 7.5. |
| `docker run` says `port already in use: 18789` | Stop any other Gateway: `docker rm -f openclaw && lsof -ti :18789 \| xargs kill` |
| `curl http://127.0.0.1:18789/healthz` returns nothing | Container probably failed to start — `docker logs openclaw` |
| `AUTH_TOKEN_MISMATCH` from `npm run health` | `.env`'s token doesn't match the one passed to `docker run`. Re-read `~/.openclaw-secrets/gateway-token`. |
| `OPENCLAW_GATEWAY_TOKEN is not set` from any script | You're in a new shell — re-export: `export OPENCLAW_GATEWAY_TOKEN="$(cat ~/.openclaw-secrets/gateway-token)"`. |
| `PAIRING_REQUIRED` from any script | You're not on loopback. SSH-tunnel: `ssh -L 18789:127.0.0.1:18789 user@host` |
| `models.authStatus` shows `openai: { status: "error" }` | Bad OpenAI key, or OpenAI's API is down. Re-test with the `curl` command from step 7. |
| `INVALID_REQUEST` on `config.patch` | `raw` isn't a string. Always `JSON.stringify(...)`. The schema is in `src/gateway/protocol/schema/config.ts`. |
| Container exits immediately with `refusing to bind gateway ... without auth` | You're using `--bind lan` without `OPENCLAW_GATEWAY_TOKEN`. Re-read step 4. |
| Build fails with `ERR_PNPM_STORE_ADD_FAILURE` | See `../ISSUES.md` Issue #1 |

---

## Source map

Every command, schema, and config key in this doc traces back to:

- **Docker setup** — repo `Dockerfile`, `docker-compose.yml`, `docs/install/docker.md`
- **`--allow-unconfigured` flag** — `src/cli/gateway-run-argv.ts:18`
- **Health/Ready endpoints** — `Dockerfile:319–325`
- **WS protocol + handshake** — `docs/gateway/protocol.md`, `src/gateway/protocol/version.ts`
- **RPC method names + scopes** — `src/gateway/methods/core-descriptors.ts`
- **`config.patch.raw` is a string** — `src/gateway/protocol/schema/config.ts:22–34`
- **`channels.start` / `channels.status` schemas** — `src/gateway/protocol/schema/channels.ts:633–778`
- **OpenAI provider config + `openai/gpt-5.5` default** — `docs/reference/wizard.md`

Companion docs in this folder:

- `README.md` — project usage reference
- `../openclaw-docker-build-and-run.md` — the docker-specific deep dive
- `../openclaw-ubuntu-daemon-websocket-bootstrap.md` — bare Ubuntu version of this same flow
- `../openclaw-gateway-websocket-setup.md` — protocol-level handshake reference
- `../ISSUES.md` — known build and runtime issues
