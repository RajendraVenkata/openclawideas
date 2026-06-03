# Bare Gateway Loop — OpenClaw startup steps 1–5

A **faithful, runnable extraction** of the first things the OpenClaw Gateway
daemon does when it boots, taken from the `openclaw` repo:

1. **Port resolution** — `OPENCLAW_GATEWAY_PORT` → `gateway.port` → `18789`
2. **Auth layer** — resolve token / password / trusted-proxy / none
3. **Config hot-reload watcher** — `gateway.reload.mode` (default `hybrid`)
4. **HTTP/WebSocket server** — single multiplexed listener
5. **Channels** — load + register + start every enabled channel (here: WhatsApp)

The goal is to see *how it was coded ground up*. For steps 1–4, wherever possible
the files here are the **real openclaw source, copied verbatim**, kept at their
**real relative paths** (`src/config/…`, `src/gateway/…`, `src/gateway/server/…`)
with their real imports intact. Only a few leaves are shimmed/condensed where the
genuine dependency tree explodes — each is clearly labelled at the top of the file.

Step 5 (channels) is a **faithful-in-shape** mini-subsystem with a **simulated
WhatsApp transport** — see [the channels note](#step-5--channels-whatsapp) for why.

This corresponds to **section "2. Startup sequence — what the daemon boots"** in
`../openclaw-daemon-internals.md` (points 1–4 are startup; channels are part of the
broader boot the doc describes).

---

## Run it

```bash
cd openclawideas/bare-gateway-loop
npm install            # one dependency: tsx (to run TypeScript directly)
npm start              # boots on 127.0.0.1:18789
```

You'll see each step happen:

```
[gateway] booting bare loop — reading config: …/openclaw.json
[gateway] step 1 — port=18789 bindHost=127.0.0.1 loopback=true
[gateway] step 2 — auth mode=token (source=token) secret=set (16 chars) allowTailscale=false
[gateway] step 3 — reload mode=hybrid debounceMs=300 (watching …/openclaw.json)
[gateway] step 4 — listening on ws://127.0.0.1:18789  (HTTP + WebSocket)
[gateway] channel registered: whatsapp (WhatsApp)
[whatsapp] connecting (account=default) — SIMULATED, no Baileys/QR
[gateway] step 5 — channels started: whatsapp
[gateway] ready. Try: …
```

### Poke it (in another terminal)

```bash
# HTTP, no auth needed:
curl -s http://127.0.0.1:18789/health
# → {"ok":true,"surface":"http"}

# HTTP, auth required (step 2 wired into step 4):
curl -s http://127.0.0.1:18789/whoami
# → {"ok":false,"error":{"code":"UNAUTHORIZED"}}
curl -s -H "Authorization: Bearer dev-secret-token" http://127.0.0.1:18789/whoami
# → {"ok":true,"you":"authorized","path":"/whoami"}

# WebSocket upgrade on the SAME port (single multiplexed listener):
curl -s -i --max-time 2 \
  -H "Authorization: Bearer dev-secret-token" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Version: 13" \
  http://127.0.0.1:18789/
# → HTTP/1.1 101 Switching Protocols / Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

### Watch step 3 hot-reload

While it's running, edit `openclaw.json` (e.g. change the `token`). Within
`debounceMs` you'll see:

```
[gateway] step 3 — config reloaded; auth now mode=token (source=token) secret=set (18 chars) …
```

…and the old token starts returning `401` while the new one is accepted — the
in-memory snapshot was swapped live, exactly as `gateway.reload.mode: "hot"/"hybrid"`
does in the real daemon.

### Step 5 — channels (WhatsApp)

Simulate an inbound WhatsApp message (the real transport would deliver this; here
we inject it over HTTP):

```bash
curl -s -H "Authorization: Bearer dev-secret-token" -H "content-type: application/json" \
  -d '{"from":"+15551234567","text":"hello from my phone"}' \
  http://127.0.0.1:18789/channels/whatsapp/inbound
# → {"ok":true,"channel":"whatsapp","accepted":true}
```

The HTTP response just **acknowledges** the message (like a real inbound webhook); the
reply is delivered back out the channel. In the gateway console you'll see the full
**ingress → route → agent → egress** roundtrip:

```
📥 [whatsapp ← +15551234567] hello from my phone
[channels] routed → agent:main:main
📤 [whatsapp → +15551234567] 🤖 (echo agent) [whatsapp] from +15551234567: hello from my phone — …
```

Other behaviours: an unknown channel → `404 NO_SUCH_CHANNEL`; missing token → `401`.
Set `channels.whatsapp.enabled: false` in `openclaw.json` and step 5 logs
`channels started: (none enabled)`.

#### How faithful is step 5? (and where real Baileys goes)

Step 5 uses the **real OpenClaw channel-plugin names and shapes** — `ChannelPlugin`,
`createChatChannelPlugin`, `defineChannelMessageAdapter`, `whatsappPlugin`,
`whatsappChannelOutbound`, `whatsappMessageAdapter`, `sendMessageWhatsApp`, a plugin
**catalog**, and the inbound **route/envelope** — laid out across the real paths
(`src/plugin-sdk/`, `src/channels/plugins/`, `extensions/whatsapp/src/`). It is a
faithful **subset**: the real `ChannelPlugin` has ~40 adapter slots; we implement the
few a text channel needs.

Only two things are **stubbed**, both clearly labelled:

| Stubbed here | Real WhatsApp |
|---|---|
| `whatsappTransport.connect()` (prints, no wire) | `extensions/whatsapp/src/channel.runtime.ts` + `connection-controller.ts` — **Baileys**: `makeWASocket()`, QR pairing, encryption, `messages.upsert` |
| `runAgent()` echo (`src/agent/run-agent-stub.ts`) | the embedded Pi **agent loop** (`runEmbeddedPiAgent`) |

So everything **above** the wire — catalog registration, config-gated loading,
connecting the transport, routing inbound to an `{ agentId, sessionKey }`, running the
agent, and delivering the reply via `message.send.text → outbound.sendText →
sendMessageWhatsApp` — uses the genuine structure. Only the bottom wire and the agent
are faked.

The full delivery chain, real names:

```
inbound → resolveInboundRoute → runAgent → whatsappMessageAdapter.send.text(ctx)
        → whatsappChannelOutbound.sendText → sendMessageWhatsApp(to, text)  [→ Baileys]
```

#### A second channel — Microsoft Teams

MS Teams is also a real bundled plugin (`extensions/msteams/`), so it's added the same
way — and adding it needed **zero changes** to the catalog, manager, router, or agent.
Just the plugin files + one side-effect import + config. The genuine differences are
preserved:

- `sendMessageMSTeams({ to, text })` takes a **params object** (WhatsApp's is positional)
- `msteamsMessageAdapter` is built with **`createChannelMessageAdapterFromOutbound`** (WhatsApp hand-writes `defineChannelMessageAdapter`)
- capabilities `["direct", "channel", "thread"]` (Teams has no "group")
- transport is **Bot Framework / Azure Bot Service** (simulated here), not Baileys

```bash
curl -s -H "Authorization: Bearer dev-secret-token" -H "content-type: application/json" \
  -d '{"from":"user@contoso.com","text":"hi teams"}' \
  http://127.0.0.1:18789/channels/msteams/inbound
# → {"ok":true,"channel":"msteams","accepted":true}
# console: 📥 [msteams ← user@contoso.com] hi teams → routed → 📤 [msteams → …]
```

That a new channel drops in with no core changes is the whole point of the
`ChannelPlugin` contract — exactly how the real product onboards ~20 channels.

### Try the other precedence rules

```bash
OPENCLAW_GATEWAY_PORT=19911 npm start        # step 1: env beats config
OPENCLAW_GATEWAY_TOKEN=from-env npm start     # step 2: env token (config-first here, so config still wins)
```

---

## File map — what's real, what's shimmed

Every file names its origin at the top. Relative paths mirror the real repo.

| File (here) | Origin in `openclaw` | Step | Fidelity |
|---|---|---|---|
| `src/config/paths.ts` | `src/config/paths.ts` | 1 | **Verbatim** `resolveGatewayPort` + `DEFAULT_GATEWAY_PORT` (+ a loopback slice of bind-host logic) |
| `src/gateway/auth-mode-policy.ts` | same | 2 | **Verbatim** (whole file) |
| `src/gateway/credentials.ts` | `src/gateway/credentials.ts` | 2 | **Verbatim** `resolveGatewayCredentialsFromValues` + faithful trim helpers |
| `src/gateway/auth-resolve.ts` | same | 2 | **Verbatim** (whole file) |
| `src/gateway/config-reload-settings.ts` | same | 3 | **Verbatim** (whole file) |
| `src/gateway/config-reload.ts` | `src/gateway/config-reload.ts` | 3 | **Condensed**: real public shape + real debounce mechanic, `fs.watch` instead of `chokidar` |
| `src/gateway/server/http-listen.ts` | same | 4 | **Verbatim** (whole file) |
| `src/infra/gateway-lock.ts` | same | 4 | **Verbatim** `GatewayLockError` class |
| `src/utils.ts` | same | 4 | **Verbatim** `sleep` |
| `src/config/types.gateway.ts` | same | — | **Shim**: only the touched type fragments, copied verbatim |
| `src/config/types.openclaw.ts` | same | — | **Shim**: minimal root config (only `gateway` + `secrets.defaults`) |
| `src/config/types.secrets.ts` | same | — | **Shim**: `resolveSecretInputRef` / `hasConfiguredSecretInput` for the inline-string case; full SecretRef provider system omitted |
| `src/config/types.channels.ts` | `src/channels/channel-config.ts` + plugin configs | 5 | **Shim**: WhatsApp config only |
| `src/plugin-sdk/channel-core.ts` | `src/channels/plugins/{channel-id.types,types.core,types.adapters,types.plugin}.ts` + `src/plugin-sdk/channel-{core,message}.ts` | 5 | **Faithful subset**: real names (`ChannelPlugin`, `createChatChannelPlugin`, `defineChannelMessageAdapter`); ~40 adapters → a few |
| `src/plugin-sdk/inbound-envelope.ts` | same | 5 | **Faithful subset**: `resolveInboundRoute` + envelope formatting |
| `src/channels/plugins/catalog.ts` | `src/channels/plugins/catalog.ts` + `src/plugins/*` | 5 | **Faithful subset**: plugin registry + enabled-plugin lookup |
| `src/channels/channel-manager.ts` | gateway channel subsystem | 5 | **Faithful shape**: connect transports, route inbound, deliver replies |
| `extensions/whatsapp/src/channel.ts` | `extensions/whatsapp/src/channel.ts` | 5 | **Faithful**: `whatsappPlugin = createChatChannelPlugin({…})` (adapter subset) |
| `extensions/whatsapp/src/channel-outbound.ts` | same | 5 | **Faithful**: `whatsappChannelOutbound` + `whatsappMessageAdapter` |
| `extensions/whatsapp/src/send.ts` | same | 5 | **Simulated leaf**: `sendMessageWhatsApp` prints instead of Baileys |
| `extensions/whatsapp/src/channel.runtime.ts` | `channel.runtime.ts` + `connection-controller.ts` | 5 | **Simulated transport** (no Baileys/QR) |
| `extensions/whatsapp/src/{accounts,register}.ts` | same | 5 | **Faithful subset**: account resolve + bundled registration |
| `extensions/msteams/src/*.ts` | `extensions/msteams/src/*` | 5 | **Faithful subset**: `msteamsPlugin`, `sendMessageMSTeams`, `createChannelMessageAdapterFromOutbound`; Bot Framework transport simulated |
| `src/agent/run-agent-stub.ts` | embedded Pi agent (`runEmbeddedPiAgent`) | 5 | **Stub**: echo instead of the real agent loop |
| `src/bootstrap.ts` | *(new)* | 1–5 | Orchestrator — stands in for `startGatewayServer` |

---

## The real call graph this stands in for

```
entry.ts                         (src/entry.ts)
  └─ runCli("gateway")
       └─ startGatewayServer()           (src/gateway/server.impl.ts:539)   ← ~700 LOC, full stack
            ├─ resolveGatewayPort()       (src/config/paths.ts)             ← STEP 1   [verbatim here]
            ├─ assertExplicitGatewayAuthModeWhenBothConfigured()
            │                             (src/gateway/auth-mode-policy.ts)  ← STEP 2   [verbatim here]
            ├─ resolveGatewayAuth()       (src/gateway/auth-resolve.ts)      ← STEP 2   [verbatim here]
            ├─ resolveGatewayReloadSettings()
            │                             (src/gateway/config-reload-settings.ts) ← STEP 3 [verbatim here]
            ├─ startGatewayConfigReloader()
            │                             (src/gateway/config-reload.ts)     ← STEP 3   [condensed here]
            ├─ createGatewayHttpServer()  (src/gateway/server-http.ts:473)   ← builds full handler (omitted)
            ├─ listenGatewayHttpServer()  (src/gateway/server/http-listen.ts)← STEP 4   [verbatim here]
            └─ startChannels()            (gateway channel subsystem)        ← STEP 5   [faithful subset here]
                 ├─ getEnabledChannelPlugins()  (src/channels/plugins/catalog.ts)
                 └─ whatsappPlugin = createChatChannelPlugin({…})  (extensions/whatsapp/src/channel.ts)
                      ├─ transport.connect()      (channel.runtime.ts + connection-controller.ts → Baileys) [simulated]
                      └─ message.send.text → outbound.sendText → sendMessageWhatsApp()  (send.ts → Baileys)  [simulated]
```

`bootstrap.ts` calls the same primitives in the same order. The big piece it does
**not** reproduce is `createGatewayHttpServer()` — in the real daemon that assembles
the Control UI, OpenAI-compatible HTTP, plugin routes, hooks, and the protocol-v4
WebSocket/RPC stack. Here, step 4 uses a minimal real `http.createServer` plus a
real RFC6455 WebSocket upgrade handshake so you can see "one port, both protocols"
gated by the resolved auth — then stops at the point where the full protocol layer
would begin.

## What is intentionally left out

- The on-disk **gateway lock file** (only the `GatewayLockError` it throws is kept).
- The full **SecretRef** secret-provider subsystem (`env:`/`file:`/`exec:`).
- **chokidar**-based multi-file watching and reload *planning* (which keys are
  hot-swappable vs require a restart) — the condensed watcher just re-reads + swaps.
- Everything downstream of binding the port: protocol handshake, RPC router,
  channels, sessions, the agent loop. (Those are steps 5–10 in the daemon-internals doc.)
