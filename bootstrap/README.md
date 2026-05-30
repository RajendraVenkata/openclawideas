# openclaw-ws-bootstrap

Minimal TypeScript sample that configures an **unconfigured** OpenClaw Gateway over WebSocket. Points at a Gateway you've already started (in your case: the Docker container running `--allow-unconfigured` on `127.0.0.1:18789`).

Three runnable scripts:

| Script | Command | What it does |
|---|---|---|
| Health | `npm run health` | Connect, handshake, call `health`. Prints `hello-ok` details. The smoke test. |
| Bootstrap | `npm run bootstrap` | Connect, snapshot state, apply provider + model + Telegram config, verify. Idempotent. |
| Watch | `npm run watch` | Subscribe to live events. Lets you see channel inbound traffic as it arrives. |

No `@openclaw/sdk` dep — raw `ws` so the protocol is fully visible. Read `src/client.ts` to see the handshake on the wire.

---

## Prerequisites

- Node 22.19+ (the OpenClaw Gateway minimum). Node 20 also works for this client; you only need 22+ if you'd run the Gateway itself locally.
- The Gateway is reachable at `OPENCLAW_GATEWAY_URL` (default `ws://127.0.0.1:18789`).
- You have the gateway token in `OPENCLAW_GATEWAY_TOKEN`.

The container you have running already satisfies these. The `healthz` curl you just did is the HTTP-side proof; this project does the WS-side equivalent.

---

## Setup

```bash
cd openclawideas/bootstrap
npm install
cp .env.example .env
# edit .env — at minimum set OPENCLAW_GATEWAY_TOKEN
```

Then load env vars into the shell (the project does not depend on `dotenv` to keep deps small). Pick one:

**bash / zsh:**
```bash
set -a
source .env
set +a
```

**fish:**
```fish
export (cat .env | grep -v '^#' | grep -v '^$' | string split -m1 =)
```

**PowerShell:**
```powershell
Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*([^#][^=]*)=(.*)$') {
    [Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2].Trim())
  }
}
```

---

## Step 1 — Smoke test

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
  negotiated scope: operator.admin, operator.read, operator.write, ...
  policy          : maxPayload=26214400  tick=15000ms

→ rpc: health
✓ health: {
  "ok": true,
  ...
}
```

If you get `Gateway error: ... AUTH_TOKEN_MISMATCH` → wrong token. If `WebSocket closed (1008)` → the gateway is requiring device pairing (means we're not on loopback — see "Connecting from a non-loopback host" below).

---

## Step 2 — Configure end-to-end

```bash
# Set provider + Telegram in .env (or your shell), then:
npm run bootstrap
```

`bootstrap.ts` runs these RPCs in order:

| # | RPC | What |
|---|---|---|
| 1 | `connect` | Handshake |
| 2 | `health` | Sanity |
| 3 | `models.list` `view=configured` | Before snapshot |
| 4 | `channels.status` | Before snapshot |
| 5 | `agents.list` | Before snapshot |
| 6 | `config.patch` | Anthropic API key + default model + workspace + `session.dmScope` *(only if `ANTHROPIC_API_KEY` set)* |
| 7 | `models.list` / `models.authStatus` | Confirms provider live |
| 8 | `config.patch` | Telegram bot token + `dmPolicy: "allowlist"` *(only if Telegram envs set)* |
| 9 | `channels.start` `channel=telegram` | Bring the channel up |
| 10 | `channels.status` `probe=true` | Live audit of the channel |
| 11 | `channels.status` `probe=true` (all channels) | Final state |
| 12 | `agents.list` | Final state |

Each step is **idempotent**: re-running the script is safe. `config.patch` merges; previously-set keys you don't touch are preserved.

If you set neither `ANTHROPIC_API_KEY` nor the Telegram envs, the script still runs — it just prints a snapshot and exits cleanly. Useful for "what's currently configured" diagnostics.

---

## Step 3 — Watch live events

```bash
npm run watch
```

The script subscribes to all session events and prints them as they arrive. Then DM your Telegram bot — you should see `sessions.changed`, `session.message`, `agent` events stream in.

Filters out `tick` / `heartbeat` noise by default. Ctrl-C to stop.

---

## File map

```
bootstrap/
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── README.md
└── src/
    ├── client.ts         # Reusable WS client + RPC + event subscription
    ├── health.ts         # Smoke test (npm run health)
    ├── bootstrap.ts      # Full configuration (npm run bootstrap)
    └── watch-status.ts   # Live event stream (npm run watch)
```

---

## Connecting from a non-loopback host

`client.ts` connects as a **trusted same-process backend client** (`client.id: "gateway-client"`, `client.mode: "backend"`), which lets us skip device-pairing **only on direct-loopback connections**. From `docs/gateway/protocol.md`:

> *"Trusted same-process backend clients (`client.id: "gateway-client"`, `client.mode: "backend"`) may omit `device` on direct loopback connections when they authenticate with the shared gateway token/password. Remote clients ... still use the normal pairing and scope-upgrade checks."*

So if you point `OPENCLAW_GATEWAY_URL` at a non-loopback target (tailnet, LAN, public host), the Gateway will return `pairing required`. Fixes:

- Easiest: **SSH-tunnel the loopback port** to your machine and keep using `ws://127.0.0.1:18789`:
  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@gateway-host
  ```
- Or extend `client.ts` to include a `device` block with a generated keypair + signed challenge, and approve the request on the gateway side (`openclaw devices approve <requestId>`).

For the SaaS / multi-tenant case the right answer is usually a separate Gateway per tenant on its own host or container — see `openclaw-ubuntu-daemon-websocket-bootstrap.md` and `openclaw-docker-build-and-run.md` in this folder.

---

## How this maps to the gateway docs in this folder

| Doc | Relationship |
|---|---|
| `openclaw-gateway-websocket-setup.md` | Protocol/handshake reference. `client.ts` is the concrete implementation. |
| `openclaw-channels-via-websocket.md` | The methods `bootstrap.ts` calls for Telegram (the table at §1). |
| `openclaw-ubuntu-daemon-websocket-bootstrap.md` | Same bootstrap flow described in prose; this is the runnable version. |
| `openclaw-docker-build-and-run.md` | How you got the container running. This project drives it. |

---

## Extending the bootstrap

Add new steps to `bootstrap.ts` by copy-pasting the `await step("name", async () => { ... })` pattern.

The methods you'll most likely want next (all on the same WS surface, all with schemas in `src/gateway/protocol/schema/*.ts`):

```typescript
// Create an isolated per-tenant agent
await step("agents.create work", async () =>
  client.rpc("agents.create", {
    name: "work",
    workspace: "/home/node/.openclaw/workspace-work",
    model: "anthropic/claude-sonnet-4-6",
  }),
);

// Bind a Telegram account to that agent
await step("config.patch — binding", async () =>
  client.rpc("config.patch", {
    raw: JSON.stringify({
      bindings: [
        {
          agentId: "work",
          match: { channel: "telegram", accountId: "default" },
        },
      ],
    }),
  }),
);

// Schedule a recurring agent run (every day at 9am UTC)
await step("cron.add daily news digest", async () =>
  client.rpc("cron.add", {
    job: {
      id: "daily-news",
      schedule: "0 9 * * *",
      command: "Summarize today's AI news",
    },
  }),
);

// Inspect a config slice
await step("config.schema.lookup channels.msteams", async () =>
  client.rpc("config.schema.lookup", { path: "channels.msteams" }),
);
```

For WhatsApp specifically you also need `web.login.start` / `web.login.wait` (QR loop) — see `openclaw-channels-via-websocket.md` § 4 for the exact pattern.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `timeout waiting for connect.challenge` | Gateway not reachable, or wrong URL | Check `OPENCLAW_GATEWAY_URL`; `curl http://...18789/healthz` |
| `Gateway error: AUTH_TOKEN_MISMATCH` | Token doesn't match container's `OPENCLAW_GATEWAY_TOKEN` | Re-read the token you used at `docker run` |
| `Gateway error: PAIRING_REQUIRED` | Connecting from non-loopback | SSH-tunnel; see "Connecting from a non-loopback host" |
| `WebSocket closed (1008)` | Auth failure | Same as above |
| `Gateway error: UNAVAILABLE` `startup-sidecars` | Container still warming up | Wait a few seconds, retry |
| `rpc timeout: <method>` | Method handler is slow or container is overloaded | Bump `RPC_TIMEOUT_MS` in `client.ts` |
| `Gateway error: INVALID_REQUEST` on `config.patch` | `raw` isn't a string | Always `JSON.stringify(...)` — `raw` is a JSON5 string per `src/gateway/protocol/schema/config.ts` |
