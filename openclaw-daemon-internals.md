# OpenClaw Gateway Daemon — Inner Mechanics

> What the OpenClaw daemon runs, the loop it executes, and the files it reads.
> Compiled from the markdown documentation in this repo. Sources are cited inline.
> **Provenance note:** Statements cited to `docs/**` come from the official OpenClaw
> documentation and are authoritative. Statements cited to `openclawideas/**` come from
> research/deep-dive notes (they name internal source files like `src/entry.ts`); treat
> those as a faithful guide that should be confirmed against source before relying on exact
> symbol/path names.

---

## 1. What the daemon is

OpenClaw is a single-user personal AI assistant. The **Gateway** is the daemon: it is the
control plane, not the assistant itself.

> "One always-on process for routing, control plane, and channel connections. Single
> multiplexed port for: WebSocket control/RPC, HTTP APIs, Plugin HTTP routes, Control UI
> and hooks." — `docs/gateway/index.md`

- **One process** (Node.js, Node 22.19+ / Node 24 recommended) that stays running as an OS service.
- **One multiplexed port** (default `18789`, bound to `127.0.0.1` by default) serves WebSocket
  RPC + HTTP APIs + plugin routes + Control UI.
- It connects to messaging channels (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, …),
  routes inbound messages to agents, runs the agent, and delivers replies back.

Process supervision keeps it alive (`openclawideas/openclaw-gateway-deep-dive.md`):

| OS | Supervisor | Unit / label |
|---|---|---|
| macOS | `launchd` LaunchAgent | `ai.openclaw.gateway` (`~/Library/LaunchAgents/ai.openclaw.gateway.plist`) |
| Linux | `systemd` user unit | `openclaw-gateway.service` (`~/.config/systemd/user/`), needs `loginctl enable-linger` |
| Windows | Scheduled Task | `OpenClaw Gateway` (Startup-folder fallback) |

`openclaw doctor` audits/repairs supervisor and config drift.

---

## 2. Startup sequence — what the daemon boots

From `openclawideas/openclaw-gateway-deep-dive.md` (entry `src/entry.ts` →
`src/daemon/gateway-entrypoint.ts`):

1. **Port resolution** — `--port` → `OPENCLAW_GATEWAY_PORT` → `gateway.port` → `18789`;
   bind from `gateway.bind` (default `loopback`).
2. **Auth layer** — load token/password, or configure trusted-proxy / Tailscale / none.
3. **Config hot-reload watcher** — `gateway.reload.mode` (default `hybrid`; `off|hot|restart|hybrid`).
4. **HTTP/WebSocket server** — single multiplexed listener.
5. **Channel plugins** — load + register every enabled channel (WhatsApp/Baileys, Telegram/grammY,
   Slack, Discord, Signal, iMessage, …).
6. **Embedded Pi agent runtime** — one `runEmbeddedPiAgent` instance per Gateway.
7. **Session store mount** — load sessions from `~/.openclaw/agents/<agentId>/sessions/`.
8. **RPC method router** — `src/gateway/server-methods-list.ts`.
9. **Plugin hook bus** — register `before_*` / `after_*` hooks.
10. **Device/node pairing** — load approved device tokens from state.

After startup, the running process serves an **in-memory config snapshot** and does not re-read
config from disk on hot paths; hot-reload swaps the snapshot atomically (`docs/gateway/index.md`,
`openclawideas/openclaw-gateway-deep-dive.md`). A **last-known-good config** is backed up after
each successful startup and can be restored with `openclaw doctor --fix` (`docs/gateway/configuration.md`).

---

## 3. The main loop — what code loop the daemon runs

The Gateway does **not** itself spin a classic "agent loop." Instead it runs a **lane-aware FIFO
queue** that serializes agent runs, while the *agent loop* proper is the embedded Pi runtime
executed per turn.

### 3a. The queue / dispatch loop (`docs/concepts/queue.md`)

> "A lane-aware FIFO queue drains each lane with a configurable concurrency cap (default 1 for
> unconfigured lanes; main defaults to 4, subagent to 8)." — `docs/concepts/queue.md`

- **Per-session lane** `session:<key>` — only one run active per session at a time
  (prevents tool/session races, keeps history consistent).
- **Global lanes** cap total parallelism: `main` (default 4 via `agents.defaults.maxConcurrent`),
  `cron` (`cron.maxConcurrentRuns`), `nested`, `subagent` (8).

**Steering** — what happens to a message that arrives while a run is active (`docs/concepts/queue.md`):

| Mode | Behavior |
|---|---|
| `steer` (default) | Inject the message into the active run **after the current assistant turn finishes its tool calls, before the next LLM call** |
| `followup` | Wait for the run to end, then start a new turn |
| `collect` | Coalesce queued messages into a single follow-up turn after a quiet window |
| `interrupt` | Abort the active run and run the newest message |

### 3b. The agent loop (per turn) — `docs/concepts/agent-loop.md`

> "An agentic loop is the full 'real' run of an agent: intake → context assembly → model
> inference → tool execution → streaming replies → persistence." — `docs/concepts/agent-loop.md`

The concrete cycle inside `runEmbeddedPiAgent`:

1. **Intake & session load** — resolve model + auth profile, load the Pi session, acquire the
   session write lock.
2. **Context assembly** — build system prompt from OpenClaw base + skills prompt + bootstrap
   files + per-run overrides; enforce model token limits.
3. **Model inference** — call embedded `pi-agent-core` with the assembled prompt.
4. **Tool execution** — Pi emits tool calls; OpenClaw runs them (`before_tool_call` /
   `after_tool_call` hooks), sanitizes results, returns them.
5. **Streaming replies** — assistant deltas stream out; block/preview streaming updates channel
   messages (Telegram/Discord/Slack preview message).
6. **Loop continuation** — the model decides whether to call more tools or finish.
7. **Persistence** — transcript written to JSONL under the session write lock.

Event bridging (`subscribeEmbeddedPiSession`): Pi `tool` events → `stream:"tool"`; assistant
deltas → `stream:"assistant"`; lifecycle → `stream:"lifecycle"` (`phase: start|end|error`).

The `agent` RPC is **two-stage**: it validates params, persists metadata, and returns
`{ runId, acceptedAt }` immediately; then streams `agent` events; then a final completion `res`
with `status: "ok" | "error"`. `agent.wait` blocks for the lifecycle end/error of a `runId`.

### 3c. Concurrency & the write lock (`docs/concepts/agent-loop.md`)

Transcript writes are guarded by a **process-aware, file-based session write lock** — it catches
writers that bypass the in-process queue or come from another process.

| Setting | Default |
|---|---|
| `session.writeLock.acquireTimeoutMs` | `60000` |
| `session.writeLock.staleMs` | `1800000` |
| `session.writeLock.maxHoldMs` | `300000` |

Non-reentrant by default (`allowReentrant: true` to opt in). `sessions.json` writes go through a
per-store writer queue rather than the file lock.

---

## 4. Inbound message lifecycle

End-to-end flow (`docs/concepts/messages.md`):

```
Inbound message
  → routing/bindings → session key
  → queue (if a run is active)
  → agent run (streaming + tools)
  → outbound replies (channel limits + chunking)
```

Expanded (`docs/concepts/messages.md`, `docs/concepts/session.md`,
`openclawideas/openclaw-gateway-deep-dive.md`):

1. **Channel ingress** — channel plugin normalizes the message, emits `message_received`.
2. **Dedup** — short-lived cache keyed by `channel/account/peer/session/message id` drops
   redeliveries after reconnects.
3. **Debounce** — rapid consecutive messages from one sender are merged (default 2000 ms,
   `messages.inbound.debounceMs`).
4. **Binding resolution** — `(channel, account, peer) → agentId`, most-specific binding wins
   (peer → parentPeer → guild+roles → guild → team → account → channel `*` → default agent).
5. **Session key** — routed by pattern:

   | Source | sessionKey |
   |---|---|
   | Direct chat | `agent:<agentId>:<mainKey>` (default `main`) |
   | Group | `agent:<agentId>:<channel>:group:<id>` |
   | Discord/Slack channel | `agent:<agentId>:<channel>:channel:<id>` / `…:room:<id>` |
   | Cron | `cron:<job.id>` |
   | Webhook | `hook:<uuid>` |

6. **Queue / steer** — enter the session lane; steer into an active run if one exists.
7. **Agent run** — the agent loop from §3b.
8. **Delivery** — final payload assembled from assistant text + inline tool summaries; the silent
   token `NO_REPLY` / `no_reply` is filtered out; messaging-tool duplicates removed; chunked to
   channel limits (`docs/concepts/message-lifecycle-refactor.md`).

**Session reset triggers** (`openclawideas/openclaw-gateway-deep-dive.md`): daily reset (default
04:00 gateway-host local time), idle expiry (`session.reset.idleMinutes`), or manual `/new` /
`/reset` — whichever fires first.

---

## 5. Heartbeat / background tick

`docs/gateway/heartbeat.md`:

> "Heartbeat runs periodic agent turns in the main session so the model can surface anything that
> needs attention without spamming you. … it does not create background task records."

- Interval `agents.defaults.heartbeat.every` — default `30m` (or `1h` under Anthropic OAuth/token
  auth); `0m` disables.
- Defers automatically while cron work is active/queued; `skipWhenBusy: true` also defers on the
  session's subagent/nested lanes.
- Prompt reads `HEARTBEAT.md`; reply contract returns `HEARTBEAT_OK` when nothing needs attention
  (stripped if remaining content ≤ `ackMaxChars`, default 300).
- Optional `activeHours: { start, end }`, `lightContext: true` (inject only `HEARTBEAT.md`), and
  `isolatedSession: true` (fresh session per run, lower token cost).

Separately, the WS transport emits periodic `tick` / `presence` / `health` / `heartbeat` events
to connected clients (`policy.tickIntervalMs`, e.g. 15000 ms;
`openclawideas/openclaw-gateway-deep-dive.md`).

---

## 6. The WebSocket protocol (how channels, nodes, and clients connect)

From `openclawideas/openclaw-gateway-deep-dive.md` and `…-websocket-setup.md`. Current protocol
version: **4** (`src/gateway/protocol/version.ts`).

**Frame format** (JSON over WS text frames):

```jsonc
{ "type": "req",   "id": "<uuid>", "method": "<name>", "params": {...} }
{ "type": "res",   "id": "<uuid>", "ok": true,  "payload": {...} }
{ "type": "res",   "id": "<uuid>", "ok": false, "error": {...} }
{ "type": "event", "event": "<name>", "payload": {...}, "seq": 42, "stateVersion": 7 }
```

**Handshake**: Gateway sends a `connect.challenge` nonce first → client's first frame must be
`connect` (with role, scopes, auth token, signed device identity) → Gateway replies `hello-ok`
with negotiated `policy`, feature list, and a state snapshot.

**Limits**: pre-connect frames ≤ 64 KiB; post-handshake payload default 25 MB
(`policy.maxPayload`); buffered bytes default 52 MB.

**Roles & scopes**: `operator` (CLI/UI/automation) with scopes like `operator.read/write/admin`;
`node` (capability host) declaring `caps` (camera, canvas, screen, voice, talk…) + `commands` +
`permissions`. Admin-prefixed methods (`config.*`, `exec.approvals.*`, `wizard.*`, `update.*`)
always require `operator.admin`.

**Device pairing**: every WS client sends a signed device identity; new devices need approval
(`openclaw devices approve <requestId>`). Auto-approval only on direct local loopback; LAN/tailnet
connects always require explicit pairing.

**Events are not replayed** — on a `seq` gap, clients refetch via `health`, `system-presence`,
`sessions.list`.

---

## 7. HTTP API surface (same multiplexed port)

From `openclawideas/openclaw-gateway-rest-apis.md`:

| Surface | Path | Default |
|---|---|---|
| Admin RPC | `POST /api/v1/admin/rpc` (allowlisted `config.*`, `channels.*`, `agents.*`, `models.*`, `cron.*`, …) | OFF |
| Tool invoke | `POST /tools/invoke` | ON |
| OpenAI-compat | `GET /v1/models`, `POST /v1/chat/completions`, `/v1/responses`, `/v1/embeddings` | OFF |
| Canvas / A2UI | `/__openclaw__/canvas/`, `/__openclaw__/a2ui/` | ON |
| Plugin routes | per-plugin | varies |

All HTTP surfaces share the WS auth boundary (`Authorization: Bearer <token>`). Admin RPC max body
1 MB; OpenAI-compat treats the `model` field as the agent target (`openclaw/<agentId>`).

---

## 8. What files the daemon reads

All paths root under `~/.openclaw/` (gateway state/config) or `<workspace>` (agent-owned files).
State dir override: `OPENCLAW_STATE_DIR`; config override: `OPENCLAW_CONFIG_PATH`.

### Config (`docs/gateway/configuration.md`, `configuration-reference.md`)
- **`~/.openclaw/openclaw.json`** — primary config, **JSON5** (comments + trailing commas).
  Supports `$include` (confined under the config dir / `OPENCLAW_INCLUDE_ROOTS`, ≤10 levels deep).
- **`.env`** (cwd) and **`~/.openclaw/.env`** — environment variables; plus parent-process env and
  optional shell env import (`env.shellEnv.enabled`).
- Last-known-good config backup (restored via `openclaw doctor --fix`).

### Credentials & secrets (`docs/gateway/secrets.md`, `authentication.md`, `agent-workspace.md`)
- **`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`** — model OAuth/API-key auth profiles.
- **`~/.openclaw/credentials/`** — channel/provider auth state (e.g.
  `~/.openclaw/credentials/whatsapp/<accountId>/`); legacy `credentials/oauth.json`, `auth.json`.
- **`~/.openclaw/secrets.json`** — file-backed SecretRef provider (default
  `secrets.providers.filemain.path`); plus env-backed and exec-backed secrets.

### Per-agent workspace (`docs/concepts/agent-workspace.md`, `system-prompt.md`, `soul.md`)
Workspace root default **`~/.openclaw/workspace`** (`agents.defaults.workspace` /
`OPENCLAW_WORKSPACE_DIR`; per-agent `agents.list[].workspace`). Bootstrap files injected into the
system prompt:
- `AGENTS.md` (operating instructions), `SOUL.md` (persona), `USER.md` (user identity),
  `IDENTITY.md` (name/vibe/emoji), `TOOLS.md` (tool conventions), `HEARTBEAT.md` (heartbeat
  checklist), `BOOTSTRAP.md` (first-run only), `BOOT.md` (optional startup checklist).
- Truncation caps: `bootstrapMaxChars` (12000), `bootstrapTotalMaxChars` (60000).

### Memory (`docs/concepts/memory.md`, `agent-workspace.md`)
- `MEMORY.md` (curated long-term), `memory/YYYY-MM-DD.md` (+ slugged variants, indexed for search),
  `DREAMS.md`, `memory/.dreams/`.

### Skills / plugins / MCP (`docs/gateway/configuration-reference.md`, `agent-workspace.md`)
- Plugins loaded in order: `~/.openclaw/extensions/` → `<workspace>/.openclaw/extensions/` →
  `plugins.load.paths`; plus bundled plugins in core dist (`plugins.allow`/`deny`).
- Skills: `<workspace>/skills/` (highest precedence) → managed `~/.openclaw/skills/` → bundled;
  extra roots via `skills.load.extraDirs`.
- MCP servers: `mcp.servers` (stdio or remote).

### State / session persistence (`docs/concepts/agent-workspace.md`, `configuration-reference.md`)
- **`~/.openclaw/agents/<agentId>/sessions/`** — session store + transcripts
  (`sessions.json`; per-session `<sessionId>.jsonl`, Telegram topics `…-topic-<threadId>.jsonl`).
- `~/.openclaw/cron/runs/<jobId>.jsonl` — cron run logs (`sessionRetention` default 24h).
- `~/.openclaw/agents/<agentId>/agent/auth-state.json`, `…/models.json` — auth order & model catalog.
- `~/.openclaw/sandboxes/` — per-scope sandbox workspaces.
- `~/.openclaw/dns/` — wide-area DNS-SD zone files.

### Lock / network / TLS (`docs/gateway/gateway-lock.md`, `configuration-reference.md`)
- **Gateway lock** under `~/.openclaw/` — per base-port+host, survives crashes/SIGKILL; gives the
  WS listener an exclusive TCP bind (`ws://127.0.0.1:18789` by default).
- TLS: `gateway.tls.{certPath,keyPath,caPath}` (or `autoGenerate` for local/dev).
- Hook transforms: `hooks.transformsDir` (default `~/.openclaw/hooks/transforms`).
- Log file: `logging.file` (default `/tmp/openclaw/openclaw-YYYY-MM-DD.log`).

---

## 9. Key environment variables

`openclawideas/openclaw-gateway-deep-dive.md`, `…-ubuntu-daemon-websocket-bootstrap.md`:

| Var | Purpose |
|---|---|
| `OPENCLAW_GATEWAY_TOKEN` / `_PASSWORD` | WS/HTTP auth credential |
| `OPENCLAW_GATEWAY_TOKEN_FILE` | path to token file (systemd reads this) |
| `OPENCLAW_GATEWAY_PORT` | override port (default 18789) |
| `OPENCLAW_CONFIG_PATH` | path to `openclaw.json` |
| `OPENCLAW_STATE_DIR` | state dir (default `~/.openclaw/`) |
| `OPENCLAW_WORKSPACE_DIR` | agent workspace root |
| `OPENCLAW_INCLUDE_ROOTS` | allowed `$include` roots |
| `OPENCLAW_SESSION_WRITE_LOCK_*` | write-lock timeout/stale/hold tuning |

---

## 10. One-paragraph summary

The OpenClaw daemon is the **Gateway**: a single always-on Node process on one multiplexed port
(default `127.0.0.1:18789`) supervised by launchd/systemd/Task Scheduler. At startup it resolves
its port, sets up auth and config hot-reload, boots the HTTP+WebSocket server, loads channel
plugins, mounts the session store, and stands up one embedded Pi agent runtime. Its core loop is a
**lane-aware FIFO queue** that serializes runs per session and caps global concurrency; inbound
channel messages are deduped, debounced, bound to an agent, mapped to a session key, and steered
into or queued behind the active run. Each turn executes the **agent loop** — context assembly →
model inference → tool execution → streaming replies → JSONL persistence under a file-based write
lock — repeating until the model finishes. A periodic **heartbeat** runs main-session turns on a
schedule. Everything it reads lives under `~/.openclaw/` (config `openclaw.json`, credentials,
auth profiles, sessions, cron, extensions, lock) and the agent **workspace** (`AGENTS.md`,
`SOUL.md`, `USER.md`, `IDENTITY.md`, `TOOLS.md`, `HEARTBEAT.md`, `MEMORY.md`, `memory/`, `skills/`).

---

### Source documents

- Official docs: `openclaw/docs/concepts/{agent-loop,agent,architecture,messages,message-lifecycle-refactor,queue,session,streaming,agent-workspace,soul,system-prompt,memory}.md`,
  `openclaw/docs/gateway/{index,background-process,heartbeat,configuration,configuration-reference,config-agents,config-channels,config-tools,secrets,authentication,gateway-lock}.md`
- Research notes: `openclawideas/openclaw-gateway-deep-dive.md`, `openclaw-agents-deep-dive.md`,
  `openclaw-functionality.md`, `openclaw-ubuntu-daemon-websocket-bootstrap.md`,
  `openclaw-gateway-websocket-setup.md`, `openclaw-gateway-rest-apis.md`, `bootstrap/ARCHITECTURE.md`
