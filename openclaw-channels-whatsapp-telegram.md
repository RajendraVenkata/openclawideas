# Registering Channels — Telegram & WhatsApp

Grounded in `/Users/rajendra/projects/openclaw/openclaw`. Primary sources:

- `README.md` — what OpenClaw is and why channels exist
- `VISION.md` — project framing
- `docs/channels/index.md` — channel catalog
- `docs/channels/telegram.md` — Telegram channel reference
- `docs/channels/whatsapp.md` — WhatsApp channel reference
- `docs/channels/channel-routing.md` — how messages map to agents

Everything below is paraphrased or quoted from the local repo. I have **not** invented use cases the repo doesn't state — see §1 for what the repo actually says about why channels exist.

---

## 1. What channels are, and what the repo says about why we need them

A **channel** in OpenClaw is a messaging platform connection. The Gateway holds the live connection to that platform and routes inbound messages to your agent, and the agent's replies back out the same way.

What the repo explicitly states:

> *"**OpenClaw** is a personal AI assistant you run on your own devices. It answers you on the channels you already use."* — `README.md`

> *"OpenClaw is the AI that actually does things. It runs on your devices, in your channels, with your rules."* — `VISION.md`

> *"OpenClaw can talk to you on any chat app you already use. Each channel connects via the Gateway. Text is supported everywhere; media and reactions vary by channel."* — `docs/channels/index.md`

> *"Channels can run simultaneously; configure multiple and OpenClaw will route per chat."* — `docs/channels/index.md`

> *"OpenClaw routes replies **back to the channel where a message came from**. The model does not choose a channel; routing is deterministic and controlled by the host configuration."* — `docs/channels/channel-routing.md`

So the repo's stated reason for channels is: **let the assistant meet you on the chat app you already use, on your own devices, with deterministic per-channel routing.** That's the framing. The repo does not present channels as a generic "integration layer" or a multi-tenant SaaS surface — those are *your* extrapolations, not the project's framing.

### Channels actually supported (from `docs/channels/index.md`)

Discord, Feishu, Google Chat, iMessage, IRC, LINE, Matrix, Mattermost, Microsoft Teams, Nextcloud Talk, Nostr, QQ Bot, Signal, Slack, Synology Chat, Telegram, Tlon, Twitch, Voice Call (plugin), WebChat, WeChat (external plugin), WhatsApp, Yuanbao (external plugin), Zalo, Zalo Personal.

Repo's own pick for fastest setup:

> *"Fastest setup is usually **Telegram** (simple bot token). WhatsApp requires QR pairing and stores more state on disk."* — `docs/channels/index.md`

---

## 2. The shared registration model

Whatever the channel, registration in OpenClaw has the same five-step shape (paraphrased from the docs):

1. **Install the channel plugin** (bundled channels are auto-loaded; some channels need an external plugin from ClawHub).
2. **Configure the channel** in `~/.openclaw/openclaw.json` under `channels.<channel>` — at minimum, credentials and an access policy.
3. **Authenticate** — either a bot token (Telegram-style) or a QR pairing flow (WhatsApp-style).
4. **Start the Gateway** so the channel runtime opens its connection.
5. **Approve pairings / allowlists** so unknown senders can or cannot reach the bot.

Every channel obeys the same access primitives:

- `channels.<channel>.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.<channel>.allowFrom`: list of allowed sender IDs (channel-specific format)
- `channels.<channel>.groupPolicy`: `open | allowlist | disabled`
- `channels.<channel>.groupAllowFrom`: allowed senders in groups
- Per-account variants under `channels.<channel>.accounts.<id>.*`

And every channel feeds the same routing pipeline (`docs/channels/channel-routing.md`):

> Routing picks **one agent** per inbound message via this priority:
> 1. exact peer → 2. parent peer → 3. guild + roles (Discord) → 4. guild → 5. team (Slack) → 6. account → 7. channel-wide (`accountId: "*"`) → 8. default agent.

Each session key the channel produces (`agent:<agentId>:<channel>:group:<id>`, etc.) determines which workspace and session store handle the conversation.

---

## 3. Telegram — full registration walkthrough

Status from the repo: *"Production-ready for bot DMs and groups via grammY. Long polling is the default mode; webhook mode is optional."*

### Step 1 — Create the bot in BotFather

> *"Open Telegram and chat with **@BotFather** (confirm the handle is exactly `@BotFather`). Run `/newbot`, follow prompts, and save the token."*

### Step 2 — Configure token + DM policy

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
      groups: { "*": { requireMention: true } }
    }
  }
}
```

Token resolution (from `telegram.md`):
- Config wins over env.
- Env fallback `TELEGRAM_BOT_TOKEN=...` applies to the **default account only**.
- After successful startup, OpenClaw caches the bot identity for up to 24 hours; clearing/changing the token invalidates that cache.

> *"Telegram does **not** use `openclaw channels login telegram`; configure token in config/env, then start gateway."*

### Step 3 — Start gateway and approve the first DM

```bash
openclaw gateway
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

Pairing codes expire after **1 hour**.

### Step 4 — Add the bot to a group

Two IDs you need from the docs:
- Your Telegram user ID → `allowFrom` / `groupAllowFrom`
- The Telegram group chat ID → key under `channels.telegram.groups`

How to find your user ID (from the docs, safer path):
1. DM your bot.
2. Run `openclaw logs --follow`.
3. Read `from.id`.

Or via Bot API:
```bash
curl "https://api.telegram.org/bot<bot_token>/getUpdates"
```

> *"Negative Telegram supergroup IDs that start with `-100` are group chat IDs. Put them under `channels.telegram.groups`, not under `groupAllowFrom`."*

### Step 5 — Telegram-side settings

Privacy Mode (from BotFather): bots default to Privacy Mode, which limits which group messages they receive. If the bot must see everything:
- disable privacy via `/setprivacy`, **or**
- make the bot a group admin.

> *"When toggling privacy mode, remove + re-add the bot in each group so Telegram applies the change."*

Helpful BotFather toggles:
- `/setjoingroups` — allow/deny group adds
- `/setprivacy` — group visibility behavior

### Owner-only single-bot pattern (straight from the docs)

```json5
{
  channels: {
    telegram: {
      enabled: true,
      dmPolicy: "pairing",
      allowFrom: ["<YOUR_TELEGRAM_USER_ID>"],
      groupPolicy: "allowlist",
      groups: {
        "<GROUP_CHAT_ID>": {
          requireMention: true
        }
      }
    }
  }
}
```

Test from the group: `@<bot_username> ping`.

### Multi-account / multi-persona pattern

```json5
{
  channels: {
    telegram: {
      defaultAccount: "default",
      accounts: {
        default: {
          botToken: "123:ABC...",
          dmPolicy: "pairing"
        },
        alerts: {
          botToken: "987:XYZ...",
          dmPolicy: "allowlist",
          allowFrom: ["tg:123456789"]
        }
      }
    }
  }
}
```

Notes from `telegram.md`:
- One bot per agent: create one bot via BotFather per persona.
- Multiple bots in the same Telegram group: invite each bot and mention the one that should answer.
- Long polling is **process-guarded** — only one active poller per bot token per Gateway. `getUpdates` 409 conflicts mean another poller exists somewhere.

### Long polling vs webhook

Default is long polling. Webhook mode (excerpt):

```json5
{
  channels: {
    telegram: {
      webhookUrl: "https://your-host/telegram-webhook",
      webhookSecret: "...",
      webhookPath: "/telegram-webhook",
      webhookHost: "127.0.0.1",
      webhookPort: 8787
    }
  }
}
```

> *"The local listener binds to `127.0.0.1:8787`. For public ingress, either put a reverse proxy in front of the local port or set `webhookHost: \"0.0.0.0\"` intentionally."*

### Telegram-specific features the docs call out

- **Live preview streaming**: edits a single message as the agent types (`channels.telegram.streaming` ∈ `off | partial | block | progress`, default `partial`).
- **Native commands** registered with `setMyCommands` plus optional `customCommands`.
- **Inline buttons** (`channels.telegram.capabilities.inlineButtons` ∈ `off | dm | group | all | allowlist`).
- **Reaction notifications** (`reactionNotifications: off | own | all`, default `own`).
- **Forum topics** isolated as `:topic:<threadId>` in session keys; per-topic `agentId` routing supported.
- **Exec approvals over Telegram** via approver DMs.

### Telegram troubleshooting at a glance (from `telegram.md`)

| Symptom | First thing to check |
|---|---|
| Bot ignores unmentioned group messages | Privacy Mode at BotFather; toggle `/setprivacy` and re-add bot |
| Bot doesn't see any group messages | Group must be allowlisted in `channels.telegram.groups` |
| `getMe returned 401` | Wrong/expired token — refresh from BotFather |
| `BOT_COMMANDS_TOO_MUCH` on startup | Too many plugin/skill/custom menu entries |
| `getUpdates` 409 conflicts | Another poller (script, second Gateway) is using the same token |
| `Polling stall detected` repeatedly | Investigate proxy / DNS / IPv6 to `api.telegram.org` |

---

## 4. WhatsApp — full registration walkthrough

Status from the repo: *"Production-ready via WhatsApp Web (Baileys). Gateway owns linked session(s)."*

### Step 0 — Install the plugin (on-demand)

WhatsApp differs from Telegram: the runtime lives in an **external plugin**, not core.

> *"The WhatsApp runtime is distributed outside the core OpenClaw npm package so WhatsApp-specific runtime dependencies stay with the external plugin."*

Install paths from the docs:
- `openclaw onboard` and `openclaw channels add --channel whatsapp` prompt to install it.
- `openclaw channels login --channel whatsapp` also offers the install flow.
- Manual: `openclaw plugins install clawhub:@openclaw/whatsapp`.

### Step 1 — Configure access policy

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "pairing",
      allowFrom: ["+15551234567"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"]
    }
  }
}
```

`allowFrom` accepts E.164 numbers and normalizes them internally.

### Step 2 — Link WhatsApp (QR pairing)

```bash
openclaw channels login --channel whatsapp
# or for a named account
openclaw channels login --channel whatsapp --account work
```

> *"Current login is QR-based. In remote or headless environments, make sure you have a reliable path to deliver the live QR code to the phone that will scan it before starting login."*

To attach an existing/custom WhatsApp Web auth directory before login:

```bash
openclaw channels add --channel whatsapp --account work \
  --auth-dir /path/to/wa-auth
openclaw channels login --channel whatsapp --account work
```

Credentials live at `~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (with `creds.json.bak` backup).

### Step 3 — Start the Gateway

```bash
openclaw gateway
```

### Step 4 — Approve the first pairing request (if `dmPolicy: "pairing"`)

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <CODE>
```

Per the doc: *"Pairing requests expire after 1 hour. Pending requests are capped at 3 per channel."*

### Deployment patterns OpenClaw recommends (from `whatsapp.md`)

**Dedicated number (recommended)** — clearest operational mode:
- separate WhatsApp identity for OpenClaw
- clearer DM allowlists and routing boundaries
- lower chance of self-chat confusion

Minimal pattern:
```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"]
    }
  }
}
```

**Personal-number fallback** — supported but with extra safeguards. Onboarding writes:
- `dmPolicy: "allowlist"`
- `allowFrom` includes your personal number
- `selfChatMode: true`

Self-chat protections automatically:
- skip read receipts for self-chat turns
- ignore mention-JID auto-trigger that would ping yourself
- default response prefix is `[{identity.name}]` or `[openclaw]`

> *"OpenClaw recommends running WhatsApp on a separate number when possible."*

### Multi-account / multi-number pattern

From `docs/concepts/multi-agent.md` (cited in the WhatsApp doc):

```bash
openclaw channels login --channel whatsapp --account personal
openclaw channels login --channel whatsapp --account biz
```

```json5
{
  agents: {
    list: [
      { id: "home", default: true, name: "Home",
        workspace: "~/.openclaw/workspace-home" },
      { id: "work", name: "Work",
        workspace: "~/.openclaw/workspace-work" }
    ]
  },
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } }
  ],
  channels: {
    whatsapp: {
      accounts: { personal: {}, biz: {} }
    }
  }
}
```

> *"DM access control is **global per WhatsApp account** (pairing/allowlist), not per agent."*

### WhatsApp runtime behavior the docs call out

- Gateway owns the WhatsApp socket and the reconnect loop.
- Reconnect watchdog follows WhatsApp Web **transport activity**, not just inbound app-message volume — quiet sessions stay up while transport frames continue.
- Outbound sends require an active listener for the target account.
- Status and broadcast chats are ignored (`@status`, `@broadcast`).
- DMs use `session.dmScope` (default `main` collapses DMs to the agent main session).
- Group sessions are isolated as `agent:<agentId>:whatsapp:group:<jid>`.
- WhatsApp Channels/Newsletters use `agent:<agentId>:whatsapp:channel:<jid>` sessions.
- Respects host proxy env (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`).

### Plugin hooks and privacy default

WhatsApp inbound contains personal content, so **plugin `message_received` is off by default** for WhatsApp. Opt-in explicitly:

```json5
{
  channels: {
    whatsapp: {
      pluginHooks: { messageReceived: true }
    }
  }
}
```

> *"Only enable this for plugins you trust to receive inbound WhatsApp message content and identifiers."*

### Group access — two layers (from `whatsapp.md`)

1. **Group membership allowlist** (`channels.whatsapp.groups`) — if present, acts as an allowlist (`"*"` allowed).
2. **Group sender policy** (`groupPolicy` + `groupAllowFrom`).

Sender allowlist fallback: if `groupAllowFrom` is unset, runtime falls back to `allowFrom` when available.

> *"If no `channels.whatsapp` block exists at all, runtime group-policy fallback is `allowlist` (with a warning log), even if `channels.defaults.groupPolicy` is set."*

### Mentions & activation in groups

Group replies require mention by default. Mention detection includes:
- explicit WhatsApp mentions of the bot identity
- configured regex (`agents.list[].groupChat.mentionPatterns`, fallback `messages.groupChat.mentionPatterns`)
- inbound voice-note transcripts
- implicit reply-to-bot detection

> *"quote/reply only satisfies mention gating; it does **not** grant sender authorization"*

Session-level (not global config) toggles: `/activation mention` and `/activation always`.

### WhatsApp-specific delivery features

- Text chunking: `textChunkLimit` (4000 default), `chunkMode: "length" | "newline"`.
- Media: image, video, audio PTT (voice note), document.
- TTS: `/tts latest` sends the latest assistant reply as a voice note; `/tts chat on|off|default` toggles auto-TTS.
- Reaction levels: `off | ack | minimal (default) | extensive`.
- Ack reactions: `channels.whatsapp.ackReaction.{emoji, direct, group}`.
- Reply quoting modes: `off (default) | first | all | batched`.

### WhatsApp troubleshooting at a glance (from `whatsapp.md`)

| Symptom | Fix path |
|---|---|
| Not linked | `openclaw channels login --channel whatsapp` |
| Linked but reconnect loop | `openclaw channels status --probe`; tune `web.whatsapp.{keepAliveIntervalMs, connectTimeoutMs}`; back up auth dir and re-link |
| QR login times out behind proxy | Check `HTTPS_PROXY` / `NO_PROXY` env on Gateway host |
| No active listener when sending | Make sure Gateway is up and account is linked |
| Reply appears in transcript but not WhatsApp | Check Baileys outbound id; look for `auto-reply delivery failed` in logs |
| Group messages unexpectedly ignored | Check `groupPolicy` → `groupAllowFrom`/`allowFrom` → `groups` allowlist → mention gating |

> *"WhatsApp gateway runtime should use Node. Bun is flagged as incompatible for stable WhatsApp/Telegram gateway operation."*

---

## 5. Side-by-side comparison

| Aspect | Telegram | WhatsApp |
|---|---|---|
| Status | Production-ready (grammY) | Production-ready (Baileys, WhatsApp Web) |
| Runtime lives in | Core/bundled | **External plugin** `@openclaw/whatsapp` |
| Auth | Bot token from BotFather | QR code pairing with WhatsApp Web |
| Login command | `openclaw gateway` (no `channels login`) | `openclaw channels login --channel whatsapp` |
| Pairing approval | `openclaw pairing approve telegram <CODE>` | `openclaw pairing approve whatsapp <CODE>` |
| Default DM policy | `pairing` | `pairing` |
| Group default policy | `allowlist` (fallback when missing) | `allowlist` (fallback when missing) |
| Group ID format | `-100<digits>` (supergroup) under `groups` | JID `<digits>@g.us` |
| User ID format | numeric (`tg:` / `telegram:` accepted) | E.164 phone number |
| Read receipts | Not supported by Bot API | On by default (per-account override) |
| Multi-account | Multiple bot tokens under `accounts.*` | Multiple QR-paired numbers under `accounts.*` |
| Default `accountId` | `defaultAccount` or `accounts.default`, else first sorted | `defaultAccount` or `default`, else first sorted |
| Web/long-poll | Long polling default; webhook optional | Always WhatsApp Web socket; no webhook mode |
| Setup speed (per docs) | Fastest | Slower (QR + more on-disk state) |
| Self-chat support | Not specially handled | Yes (`selfChatMode: true` opt-in) |
| Plugin hook for `message_received` | On by default | **Off by default for privacy** |
| Bun runtime | Unsupported (incompatible) | Unsupported (incompatible) |

---

## 6. Common verification commands (both channels)

```bash
# Health
openclaw gateway status
openclaw gateway status --deep

# Channel status (and live probe when Gateway is reachable)
openclaw channels status
openclaw channels status --probe

# Logs to debug auth / first message routing
openclaw logs --follow

# Doctor (warns about misconfig, legacy keys, stale crontabs)
openclaw doctor
openclaw doctor --fix
```

---

## 7. What the repo does **not** say (so I'm not making it up)

The user asked me to avoid imagining content. Things the repo's own channel docs do *not* explicitly frame channels as:

- A multi-tenant SaaS gateway (no per-tenant scope model on channels)
- A generic "integration bus" for arbitrary third-party services
- A REST/HTTP API surface for setup (those exist for the Gateway, not for channels — see the separate gateway HTTP doc)
- A way to broadcast one message across many channels (the routing doc explicitly says *"replies route back to the channel where a message came from"*; broadcasting is a separate, opt-in `broadcast` feature)

If you want to build any of those on top of OpenClaw, that's plugin / wrapper work outside the channel layer.

---

## 8. Source map

- Why-channels framing: `README.md`, `VISION.md`, `docs/channels/index.md`
- Routing rules: `docs/channels/channel-routing.md`
- Telegram reference: `docs/channels/telegram.md`
- WhatsApp reference: `docs/channels/whatsapp.md`
- Multi-agent + bindings: `docs/concepts/multi-agent.md`
- Pairing: `docs/channels/pairing.md`
- Channel troubleshooting: `docs/channels/troubleshooting.md`
- Config reference: `docs/gateway/config-channels.md`
