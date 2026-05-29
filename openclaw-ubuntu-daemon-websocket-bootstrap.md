# Ubuntu: Unconfigured OpenClaw Daemon + End-to-End WebSocket Configuration

A focused, copy-pasteable runbook for the headless / SaaS provisioning case:

1. Install OpenClaw on Ubuntu.
2. Start the Gateway as a **systemd service**, completely unconfigured.
3. Configure everything (model, provider API key, channel, agent, bindings) from a remote control plane over **WebSocket RPC** — no CLI on the server, no Control UI, no `openclaw onboard`.

Grounded in `/Users/rajendra/projects/openclaw/openclaw`:
- `docs/install/index.md`, `docs/install/node.md` — install paths
- `docs/gateway/index.md` — service install, `--allow-unconfigured`
- `docs/gateway/protocol.md` — WS handshake, frame model
- `docs/gateway/configuration.md` — `gateway.auth.*`, `gateway.bind`
- `src/gateway/methods/core-descriptors.ts` — method names + scopes
- `src/gateway/protocol/schema/{channels,config,agents-models-skills}.ts` — exact param schemas
- `src/cli/gateway-run-argv.ts` — confirms `--allow-unconfigured`

Every command and method name below comes from those files.

---

## Part 1 — Provision the Ubuntu host

### 1.1 Install Node 24

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # expect v24.x
```

### 1.2 Install OpenClaw (no onboarding)

Two equivalent paths from `docs/install/index.md`:

```bash
# Path A: vendored installer with no-onboard
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard

# Path B: plain npm (after step 1.1)
sudo npm install -g openclaw@latest
```

Verify:
```bash
openclaw --version
```

> Critically, **do not run `openclaw onboard`**. That's the interactive CLI path you're skipping.

### 1.3 Generate a gateway auth token

The Gateway refuses non-loopback binds without auth (*"refusing to bind gateway ... without auth"* — `docs/gateway/index.md`), and any WS client needs it during the connect handshake.

```bash
mkdir -p ~/.openclaw
umask 077
openssl rand -hex 32 > ~/.openclaw/.gateway-token
echo "Save this — your control plane needs it:"
cat ~/.openclaw/.gateway-token
```

We'll wire this token into systemd in the next step.

---

## Part 2 — Install the daemon, unconfigured

### 2.1 systemd user unit (the documented path)

From `docs/gateway/index.md`, the Linux user-unit example. We adapt it to start unconfigured and read the token from env.

Create `~/.config/systemd/user/openclaw-gateway.service`:

```ini
[Unit]
Description=OpenClaw Gateway (unconfigured bootstrap)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=OPENCLAW_GATEWAY_TOKEN_FILE=%h/.openclaw/.gateway-token
ExecStartPre=/bin/sh -c 'export OPENCLAW_GATEWAY_TOKEN="$(cat $OPENCLAW_GATEWAY_TOKEN_FILE)"'
ExecStart=/usr/bin/env OPENCLAW_GATEWAY_TOKEN="$(cat %h/.openclaw/.gateway-token)" \
          openclaw gateway --allow-unconfigured --port 18789
Restart=always
RestartSec=5
TimeoutStopSec=30
TimeoutStartSec=30
SuccessExitStatus=0 143
KillMode=control-group

[Install]
WantedBy=default.target
```

Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable --now openclaw-gateway.service
systemctl --user status openclaw-gateway.service
```

Persistence across logout (otherwise the user unit stops when you SSH out):

```bash
sudo loginctl enable-linger "$USER"
```

> Repo flag confirmation: `--allow-unconfigured` is in `src/cli/gateway-run-argv.ts:18` and `src/cli/respawn-policy.ts:5`. It tells the Gateway to start successfully even when `~/.openclaw/openclaw.json` is missing or empty.

### 2.2 Or — the official-managed install command

The doc's preferred way installs the supervisor unit for you:

```bash
OPENCLAW_GATEWAY_TOKEN="$(cat ~/.openclaw/.gateway-token)" \
  openclaw gateway install --port 18789

systemctl --user enable --now openclaw-gateway.service
openclaw gateway status
```

You'll still need `--allow-unconfigured` somehow. The cleanest way is the user-unit override:

```bash
mkdir -p ~/.config/systemd/user/openclaw-gateway.service.d
cat > ~/.config/systemd/user/openclaw-gateway.service.d/override.conf <<'EOF'
[Service]
Environment=OPENCLAW_GATEWAY_TOKEN_FILE=%h/.openclaw/.gateway-token
ExecStart=
ExecStart=/usr/bin/env OPENCLAW_GATEWAY_TOKEN="$(cat %h/.openclaw/.gateway-token)" \
          openclaw gateway --allow-unconfigured --port 18789
EOF
systemctl --user daemon-reload
systemctl --user restart openclaw-gateway.service
```

### 2.3 Confirm the daemon is up

```bash
ss -ltnp | grep 18789
journalctl --user -u openclaw-gateway.service -n 30 --no-pager
openclaw gateway status
```

You should see the Gateway listening on `127.0.0.1:18789` (default `gateway.bind: "loopback"`).

---

## Part 3 — Reach the daemon from your control plane

The Gateway binds to loopback by default. From `docs/gateway/remote.md` and `docs/gateway/index.md`, the documented patterns:

| Reachability | How |
|---|---|
| Same host | direct WS to `ws://127.0.0.1:18789` |
| From your laptop | SSH local-forward |
| From a tailnet | Tailscale Serve (Gateway stays loopback) or LAN bind |
| Public internet | reverse proxy with auth, e.g. trusted-proxy mode |

Easiest for a SaaS control plane during initial bring-up:

```bash
# From your control plane / laptop:
ssh -N -L 18789:127.0.0.1:18789 ubuntu@<server> &
# Now ws://127.0.0.1:18789 on your machine tunnels to the Gateway.
```

> *"SSH tunnels do not bypass gateway auth. For shared-secret auth, clients still must send `token` / `password` even over the tunnel."* — `docs/gateway/index.md`

Once you've configured `gateway.bind: "lan"` and `gateway.controlUi.allowedOrigins` (or set up Tailscale / a reverse proxy), you can drop the tunnel.

---

## Part 4 — Configure end-to-end over WebSocket

This is one script. Run it on your control plane after the tunnel is up. It does the whole bootstrap.

### 4.1 The methods we'll use

From `src/gateway/methods/core-descriptors.ts`:

| Method | Scope | Why |
|---|---|---|
| `connect` | — | Handshake |
| `health` | `operator.read` | Sanity check |
| `config.schema.lookup` | `operator.read` | Validate keys before writing |
| `config.get` | `operator.read` | Snapshot before |
| `config.patch` | `operator.admin` | Write config (model, provider key, channel, bindings) |
| `models.list` | `operator.read` | Confirm model resolved |
| `models.authStatus` | `operator.read` | Confirm provider auth |
| `channels.status` | `operator.read` | Pre-flight |
| `channels.start` | `operator.admin` | Bring up the channel runtime |
| `agents.create` | `operator.admin` | Optional: per-persona agent |
| `agents.list` | `operator.read` | Verify |

All exposed natively over WS — no plugin enable required.

### 4.2 Param-schema highlights (from source)

- `config.patch.raw` is a **JSON5 string**, not a structured object. Pass `JSON.stringify(yourPatch)`.
- `channels.start { channel: string, accountId?: string }`.
- `channels.status { probe?: boolean, timeoutMs?: integer, channel?: string }`.
- `agents.create { name, workspace, model?, emoji?, avatar? }` → `{ ok, agentId, name, workspace, model? }`.

### 4.3 The bootstrap script — Node / `@openclaw/sdk`

```typescript
// bootstrap.ts
import { OpenClaw } from "@openclaw/sdk";
import fs from "node:fs/promises";

const token = (await fs.readFile(process.env.GATEWAY_TOKEN_FILE!, "utf8")).trim();
const oc = new OpenClaw({ url: "ws://127.0.0.1:18789", token });

await oc.connect();
console.log("connected. health:",
  await oc.rawRequest("health", {}));

// --- Step 1: provider API key + default model ---
await oc.rawRequest("config.patch", {
  raw: JSON.stringify({
    models: {
      providers: {
        anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
      },
    },
    agents: {
      defaults: {
        workspace: "~/.openclaw/workspace",
        model:     "anthropic/claude-sonnet-4-6",
      },
    },
    // Strongly recommended for multi-user setups, per docs/concepts/session.md
    session: { dmScope: "per-channel-peer" },
  }),
});

console.log("models configured:",
  await oc.rawRequest("models.list", { view: "configured" }));
console.log("provider auth:",
  await oc.rawRequest("models.authStatus", {}));

// --- Step 2: register a Telegram channel ---
//    (swap to msteams/whatsapp/slack with the same pattern;
//     WhatsApp needs the extra web.login.start/wait QR loop)
await oc.rawRequest("config.patch", {
  raw: JSON.stringify({
    channels: {
      telegram: {
        enabled:   true,
        botToken:  process.env.TELEGRAM_BOT_TOKEN!,
        dmPolicy:  "allowlist",
        allowFrom: [process.env.TELEGRAM_USER_ID!],   // numeric Telegram user id
        groupPolicy: "allowlist",
      },
    },
  }),
});

await oc.rawRequest("channels.start", { channel: "telegram" });

const status = await oc.rawRequest("channels.status",
  { channel: "telegram", probe: true, timeoutMs: 5000 });
console.log("telegram status:", JSON.stringify(status, null, 2));

// --- Step 3 (optional): isolated per-persona agent ---
const created = await oc.rawRequest("agents.create", {
  name:      "work",
  workspace: "~/.openclaw/workspace-work",
  model:     "anthropic/claude-sonnet-4-6",
});
console.log("agent created:", created);

await oc.rawRequest("config.patch", {
  raw: JSON.stringify({
    bindings: [
      { agentId: created.agentId,
        match:   { channel: "telegram", accountId: "default" } },
    ],
  }),
});

console.log("agents now:",
  await oc.rawRequest("agents.list", {}));

await oc.disconnect();
```

Run it:

```bash
GATEWAY_TOKEN_FILE=~/.openclaw/.gateway-token \
ANTHROPIC_API_KEY=sk-ant-... \
TELEGRAM_BOT_TOKEN=123456:ABC... \
TELEGRAM_USER_ID=8734062810 \
node --loader ts-node/esm bootstrap.ts
```

### 4.4 The bootstrap script — raw Python (no SDK)

For non-Node control planes:

```python
# bootstrap.py
import asyncio, json, os, uuid, websockets

URL    = "ws://127.0.0.1:18789"
TOKEN  = open(os.environ["GATEWAY_TOKEN_FILE"]).read().strip()

async def main():
    async with websockets.connect(URL, max_size=25 * 1024 * 1024) as ws:
        # Wait for challenge
        challenge = json.loads(await ws.recv())
        assert challenge["event"] == "connect.challenge", challenge

        # Connect with operator.admin scope
        await ws.send(json.dumps({
            "type": "req", "id": str(uuid.uuid4()), "method": "connect",
            "params": {
                "minProtocol": 4, "maxProtocol": 4,
                "client": {"id": "bootstrap", "version": "0.1",
                           "platform": "linux", "mode": "operator"},
                "role":  "operator",
                "scopes": ["operator.admin", "operator.read",
                           "operator.write", "operator.pairing"],
                "caps": [], "commands": [], "permissions": {},
                "auth": {"token": TOKEN},
            },
        }))
        hello = json.loads(await ws.recv())
        assert hello["ok"], hello

        # Simple RPC helper
        async def rpc(method, params):
            rid = str(uuid.uuid4())
            await ws.send(json.dumps(
                {"type": "req", "id": rid, "method": method, "params": params}))
            while True:
                f = json.loads(await ws.recv())
                if f.get("type") == "res" and f.get("id") == rid:
                    if not f["ok"]:
                        raise RuntimeError(f["error"])
                    return f["payload"]

        print("health:", await rpc("health", {}))

        # Step 1: provider key + default model
        await rpc("config.patch", {
            "raw": json.dumps({
                "models": {"providers": {
                    "anthropic": {"apiKey": os.environ["ANTHROPIC_API_KEY"]}
                }},
                "agents":  {"defaults": {
                    "workspace": "~/.openclaw/workspace",
                    "model":     "anthropic/claude-sonnet-4-6",
                }},
                "session": {"dmScope": "per-channel-peer"},
            })
        })

        # Step 2: Telegram
        await rpc("config.patch", {
            "raw": json.dumps({"channels": {"telegram": {
                "enabled":      True,
                "botToken":     os.environ["TELEGRAM_BOT_TOKEN"],
                "dmPolicy":     "allowlist",
                "allowFrom":    [os.environ["TELEGRAM_USER_ID"]],
                "groupPolicy":  "allowlist",
            }}})
        })
        await rpc("channels.start", {"channel": "telegram"})
        print("telegram:", await rpc("channels.status",
                                     {"channel": "telegram", "probe": True}))

        # Step 3: agent + binding
        agent = await rpc("agents.create", {
            "name":      "work",
            "workspace": "~/.openclaw/workspace-work",
            "model":     "anthropic/claude-sonnet-4-6",
        })
        await rpc("config.patch", {
            "raw": json.dumps({"bindings": [
                {"agentId": agent["agentId"],
                 "match":   {"channel": "telegram", "accountId": "default"}}
            ]})
        })
        print("agents:", await rpc("agents.list", {}))

asyncio.run(main())
```

Run it:

```bash
GATEWAY_TOKEN_FILE=~/.openclaw/.gateway-token \
ANTHROPIC_API_KEY=sk-ant-... \
TELEGRAM_BOT_TOKEN=123456:ABC... \
TELEGRAM_USER_ID=8734062810 \
python3 bootstrap.py
```

### 4.5 Channel-specific notes

The Telegram pattern above is the simple case (just a token in config). The other major channels differ:

- **WhatsApp**: needs an extra `web.login.start` + `web.login.wait` QR loop and the external `@openclaw/whatsapp` plugin pre-installed. See `openclaw-channels-via-websocket.md` in this folder for the QR-rotation pattern.
- **Microsoft Teams**: needs `appId` / `appPassword` / `tenantId` from Azure or `teams.cli` before any WS call; once you have them, the same `config.patch` + `channels.start` flow applies. See `openclaw-msteams-websocket-setup.md`.
- **Slack / Discord**: bot tokens go in `config.patch`, then `channels.start`. Same shape as Telegram.

The methods don't change — only the contents of the `config.patch` body do.

---

## Part 5 — Verify end-to-end

Once the bootstrap script returns, prove it works from the same WS connection:

```typescript
// continue in bootstrap.ts before disconnect()
const probeStatus = await oc.rawRequest("channels.status",
  { probe: true, timeoutMs: 8000 });

// Look for: channelAccounts.telegram[0].running === true
//           channelAccounts.telegram[0].connected === true
console.log(JSON.stringify(probeStatus, null, 2));
```

The `ChannelAccountSnapshot` schema (from `src/gateway/protocol/schema/channels.ts`) gives you `linked`, `running`, `connected`, `lastConnectedAt`, `lastError`, `healthState`, `lastInboundAt`, `lastOutboundAt`, `reconnectAttempts` — all you need to drive a "this tenant is healthy" dashboard.

Then DM the bot from Telegram. Tail logs on the server to watch the first inbound:

```bash
journalctl --user -u openclaw-gateway.service -f
```

---

## Part 6 — Day-2 operations (still all WS)

```typescript
// Rotate provider API key
await oc.rawRequest("config.patch", {
  raw: JSON.stringify({
    models: { providers: { anthropic: { apiKey: NEW_KEY } } },
  }),
});

// Stop a channel
await oc.rawRequest("channels.stop", { channel: "telegram" });

// Clear stored channel auth (e.g. before re-linking WhatsApp)
await oc.rawRequest("channels.logout",
  { channel: "whatsapp", accountId: "personal" });

// Live dashboard data
const snapshot = await oc.rawRequest("channels.status",
  { probe: true, timeoutMs: 8000 });

// List background work
const tasks = await oc.rawRequest("tasks.list",
  { status: ["running", "queued"], limit: 50 });
```

`gateway.reload.mode` defaults to `"hybrid"` (`docs/gateway/index.md`) — hot-safe config changes apply without a restart; reload-required ones trigger a restart automatically.

---

## Part 7 — End-to-end picture

```mermaid
sequenceDiagram
    autonumber
    participant Op as Operator
    participant UB as Ubuntu host
    participant SVC as systemd user unit
    participant GW as openclaw gateway<br/>--allow-unconfigured
    participant CP as Control plane<br/>(your laptop / SaaS)

    Op->>UB: apt install nodejs
    Op->>UB: npm install -g openclaw
    Op->>UB: openssl rand -hex 32 > .gateway-token
    Op->>SVC: write openclaw-gateway.service
    SVC->>GW: start with token + --allow-unconfigured
    GW-->>SVC: listening on 127.0.0.1:18789

    Op->>CP: ssh -L 18789:127.0.0.1:18789
    CP->>GW: ws://127.0.0.1:18789

    CP->>GW: req connect (auth.token, operator.admin)
    GW-->>CP: res hello-ok (deviceToken, scopes)

    CP->>GW: req config.patch (model + provider key)
    GW-->>CP: res ok
    CP->>GW: req models.list / models.authStatus
    GW-->>CP: res ok

    CP->>GW: req config.patch (telegram + dmPolicy + allowFrom)
    GW-->>CP: res ok
    CP->>GW: req channels.start { channel: telegram }
    GW-->>CP: res { started: true }
    CP->>GW: req channels.status { probe: true }
    GW-->>CP: res snapshot (running, connected)

    CP->>GW: req agents.create
    GW-->>CP: res { agentId }
    CP->>GW: req config.patch (bindings)
    GW-->>CP: res ok

    Note over CP,GW: From here, the daemon is fully configured.<br/>Drop the SSH tunnel; switch to Tailscale Serve<br/>or trusted-proxy for production.
```

---

## Part 8 — Hard constraints to know up front

These are from the docs; respect them or you'll hit walls.

1. **A token is mandatory for any non-loopback bind.** `gateway.bind: "lan"` without `gateway.auth.token` (or password / trusted-proxy / Tailscale) refuses to start.
2. **Loopback only by default.** Until you flip `gateway.bind` and set an auth mode, your control plane must reach the Gateway via SSH tunnel / Tailscale / a reverse proxy.
3. **Shared-secret bearer = full operator.** No per-tenant scope narrowing on shared-secret WS auth. If you need tenant isolation, run **one Gateway per tenant** (separate `OPENCLAW_CONFIG_PATH`, `OPENCLAW_STATE_DIR`, `gateway.port` — see `docs/gateway/multiple-gateways.md`).
4. **Some channels need plugins installed first.** WhatsApp specifically ships as `@openclaw/whatsapp`. You can install it on the server with `openclaw plugins install clawhub:@openclaw/whatsapp` once; the rest of the channel flow then works over WS.
5. **Channel-side sender pairing (the `openclaw pairing approve <channel> <code>` flow) is not a WS RPC.** Same gap I called out in the WhatsApp/Telegram WS docs. Workaround: use `dmPolicy: "allowlist"` with explicit `allowFrom` IDs — fully WS-driven, no on-host CLI needed.
6. **`config.patch.raw` is a JSON5 string.** It's a string in the schema — always `JSON.stringify(...)`.
7. **Events are not replayed.** If your bootstrap script's WS connection drops mid-config, reconnect, fetch current state with `config.get` + `channels.status` + `agents.list`, and resume from there.

---

## Part 9 — Source map

- `docs/install/node.md` — Ubuntu Node 24 install
- `docs/install/index.md` — installer paths
- `docs/gateway/index.md` — daemon install (Linux user-unit example), `--allow-unconfigured`, bind/port resolution, hot-reload modes
- `docs/gateway/protocol.md` — WS handshake, request/response/event frames, idempotency, error codes
- `docs/gateway/configuration.md` — `gateway.auth.*`, `gateway.bind`, `gateway.controlUi.*`
- `docs/gateway/remote.md` — SSH tunnel and Tailscale patterns
- `docs/gateway/multiple-gateways.md` — per-tenant isolation
- `src/gateway/methods/core-descriptors.ts` — every method name + scope
- `src/gateway/protocol/schema/channels.ts` — `channels.*` + `web.login.*` schemas
- `src/gateway/protocol/schema/config.ts` — `config.patch` shape
- `src/gateway/protocol/schema/agents-models-skills.ts` — `agents.*` shapes
- `src/cli/gateway-run-argv.ts` — flag inventory including `--allow-unconfigured`
- Companion docs in this folder:
  - `openclaw-gateway-websocket-setup.md` — handshake details
  - `openclaw-channels-via-websocket.md` — Telegram + WhatsApp WS deep dive
  - `openclaw-msteams-websocket-setup.md` — Teams over WS
  - `openclaw-ubuntu-web-setup.md` — same Ubuntu install but Control-UI driven

---

## TL;DR — the absolute shortest path

```bash
# On the Ubuntu host
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g openclaw@latest
openssl rand -hex 32 > ~/.openclaw/.gateway-token
# (write the systemd user unit from §2.1)
systemctl --user daemon-reload
systemctl --user enable --now openclaw-gateway.service
sudo loginctl enable-linger "$USER"

# On your control plane
ssh -N -L 18789:127.0.0.1:18789 ubuntu@<server> &
GATEWAY_TOKEN_FILE=~/.openclaw/.gateway-token \
ANTHROPIC_API_KEY=sk-ant-... \
TELEGRAM_BOT_TOKEN=... \
TELEGRAM_USER_ID=... \
node bootstrap.ts   # the script from §4.3
```

Six commands on the server, four env vars on the control plane, one TypeScript file. Daemon up, fully configured, healthy, never touched `openclaw onboard`.
