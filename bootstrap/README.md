# openclaw-ws-bootstrap

Minimal TypeScript sample that configures an **unconfigured** OpenClaw Gateway over WebSocket. Points at a Gateway you've already started (in your case: the Docker container running `--allow-unconfigured` on `127.0.0.1:18789`).

Three runnable scripts. Run them through the sidecar wrapper — **not** plain `npm run` (see "Why the sidecar?" below):

| Script | Command | What it does |
|---|---|---|
| Health | `./run-in-sidecar.sh health` | Connect, handshake, call `health`. Prints `hello-ok` details. The smoke test. |
| Bootstrap | `./run-in-sidecar.sh bootstrap` | Connect, snapshot state, apply provider + model + Telegram config, verify. Idempotent. Handles `config.get` → `baseHash` → `config.patch` for you. |
| Watch | `./run-in-sidecar.sh watch` | Subscribe to live events. Lets you see channel inbound traffic as it arrives. |

Uses `@openclaw/sdk` (the private monorepo SDK, installed as a `file:` dep from `../../openclaw/packages/sdk`). The SDK handles connection lifecycle, typed namespaces (`oc.models`, `oc.agents`, `oc.sessions`, etc.), and event streaming. For the surfaces the SDK doesn't wrap (`config.*`, `channels.*`), we use the SDK's `GatewayClientTransport.request(method, params)` directly.

### Why the sidecar?

The Gateway clears all declared scopes to `[]` for any WS connection that lacks a paired device identity **and** doesn't arrive on the gateway's own loopback interface. Connections from your Mac through `docker run -p 127.0.0.1:18789` come in on the Docker bridge — not loopback from the gateway's POV — so plain `npm run health` from the Mac returns `hello-ok` with empty scopes, then every scope-gated RPC fails with `missing scope: operator.read`.

`run-in-sidecar.sh` launches a `node:24-bookworm-slim` container with `--network=container:openclaw`, which shares the gateway's network namespace. Connections from inside the sidecar to `ws://127.0.0.1:18789` are then **real loopback** to the gateway. The `gateway-client backend` exception fires, scopes are preserved, everything works.

This mirrors OpenClaw's own `docker-compose.yml` — its `openclaw-cli` service uses `network_mode: "service:openclaw-gateway"` for the same reason.

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
├── package.json          # @openclaw/sdk via "file:../../openclaw/packages/sdk"
├── tsconfig.json
├── .env.example
├── .gitignore
├── README.md
├── SETUP.md              # From-zero walkthrough (start here for first install)
├── ARCHITECTURE.md       # How the code works (SDK + transport layering)
├── ISSUES.md             # Known gotchas with workarounds (lives at openclawideas/)
├── run-in-sidecar.sh     # Wrapper that runs scripts in a network-shared sidecar
└── src/
    ├── health.ts         # Smoke test (./run-in-sidecar.sh health)
    ├── bootstrap.ts      # Full configuration (./run-in-sidecar.sh bootstrap)
    └── watch-status.ts   # Live event stream (./run-in-sidecar.sh watch)
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

Add new steps to `bootstrap.ts` by copy-pasting the `await step("name", async () => { ... })` pattern. Pick the right call layer:

| Operation | Use |
|---|---|
| Has a typed SDK namespace (`agents`, `models`, `sessions`, `runs`, `tasks`, `tools`, `artifacts`, `approvals`) | `oc.<namespace>.<method>(...)` |
| `config.patch` (provider keys, channel config, bindings) | `configPatch(transport, {...})` — handles `baseHash` automatically |
| `config.get`, `channels.*`, `web.login.*`, `cron.*`, anything else | `transport.request("<method>", {...})` |

Examples:

```typescript
// Create an isolated per-tenant agent (SDK typed)
await step("agents.create work", async () =>
  oc.agents.create({
    name: "work",
    workspace: "/home/node/.openclaw/workspace-work",
    model: "anthropic/claude-sonnet-4-6",
  }),
);

// Bind a Telegram account to that agent (config.patch — use the helper)
await step("config.patch — binding", async () =>
  configPatch(transport, {
    bindings: [
      {
        agentId: "work",
        match: { channel: "telegram", accountId: "default" },
      },
    ],
  }),
);

// Schedule a recurring agent run (no SDK namespace for cron — raw transport)
await step("cron.add daily news digest", async () =>
  transport.request("cron.add", {
    job: {
      id: "daily-news",
      schedule: "0 9 * * *",
      command: "Summarize today's AI news",
    },
  }),
);

// Inspect a config slice (config.schema.lookup is not in the SDK)
await step("config.schema.lookup channels.msteams", async () =>
  transport.request("config.schema.lookup", { path: "channels.msteams" }),
);
```

For WhatsApp specifically you also need `web.login.start` / `web.login.wait` (QR loop) — see `openclaw-channels-via-websocket.md` § 4 for the exact pattern.

### Three gotchas when writing your own `config.patch` calls

1. **`raw` is a JSON5 string.** Always `JSON.stringify(yourPatchObject)`. If you forget, the validator returns `INVALID_REQUEST`.
2. **`baseHash` is required at runtime** even though the schema marks it optional. Use the `configPatch` helper. The Gateway uses optimistic concurrency to prevent two writers from clobbering each other.
3. **Provider entries require `baseUrl`.** If you add a new provider in a `config.patch`, include both `apiKey` and `baseUrl` (non-empty string). For OpenAI: `https://api.openai.com/v1`. For Anthropic: `https://api.anthropic.com`. The Gateway's validator fails the patch otherwise.

### When the SDK adds `config.*` and `channels.*` namespaces

Replace `configPatch(transport, {...})` with `oc.config.patch({...})` and `transport.request("channels.start", {...})` with `oc.channels.start({...})`. The transport stays as a transport — the only diff is where the methods live.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `timeout waiting for connect.challenge` | Gateway not reachable, or wrong URL | Check `OPENCLAW_GATEWAY_URL`; `curl http://...18789/healthz` |
| `Gateway error: AUTH_TOKEN_MISMATCH` | Token doesn't match container's `OPENCLAW_GATEWAY_TOKEN` | Re-read the token you used at `docker run` |
| `Gateway error: PAIRING_REQUIRED` | Connecting from non-loopback. For Docker: use `./run-in-sidecar.sh`. For SSH/remote: use the tunnel pattern in "Connecting from a non-loopback host". |
| `WebSocket closed (1008)` | Auth failure | Same as above |
| `missing scope: operator.read` (after a successful `hello-ok`) | Scopes cleared because connection isn't real loopback. Use `./run-in-sidecar.sh` instead of plain `npm run`. |
| `scopes negotiated:` line is empty in `npm run health` output | Same as above. |
| `config base hash required; re-run config.get and retry` on `config.patch` | Optimistic concurrency. Use the `configPatch()` helper from `src/bootstrap.ts` instead of raw `client.rpc("config.patch", ...)` — it auto-fetches the hash. |
| `Config validation failed: models.providers.<id>.baseUrl: Too small` | Provider entries require `baseUrl` (non-empty string). Bootstrap sends defaults; if you're hand-rolling a patch, add `baseUrl` for every provider. |
| `Gateway error: UNAVAILABLE` `startup-sidecars` | Container still warming up | Wait a few seconds, retry |
| `rpc timeout: <method>` | Method handler is slow or container is overloaded | Bump `RPC_TIMEOUT_MS` in `client.ts` |
| `Gateway error: INVALID_REQUEST` on `config.patch` | `raw` isn't a string | Always `JSON.stringify(...)` — `raw` is a JSON5 string per `src/gateway/protocol/schema/config.ts` |
