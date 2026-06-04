# OpenClaw — The Agent Layer

> How an inbound chat message is **routed to the agent**, what the **agentic loop**
> actually is, and how the **response is sent back to the chat** — traced from the real
> `openclaw/src` code (not the docs).
>
> File:line references are from the local checkout (`/Users/rajendra/projects/openclaw/openclaw`);
> exact line numbers drift between versions, but the function/file names are stable.

---

## 0. The three phases (the whole picture)

```
 CHANNEL INBOUND ─┐
                  ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │ PHASE 1 — ROUTE TO AGENT   (src/auto-reply/**, src/routing/**)        │
   │   dedupe → session key → queue/lane → dispatchReplyFromConfig         │
   └─────────────────────────────┬───────────────────────────────────────┘
                                 ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │ PHASE 2 — RUN THE AGENT    (src/agents/pi-embedded-runner/**)         │
   │   runEmbeddedPiAgent → attempt → system prompt → pi-agent-core loop   │
   │   (model → tools → repeat), events bridged back via subscribe         │
   └─────────────────────────────┬───────────────────────────────────────┘
                                 ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │ PHASE 3 — DELIVER TO CHAT  (src/auto-reply/reply/**, src/infra/**)    │
   │   normalize (NO_REPLY) → chunk → route to originating peer → send     │
   │   (+ live "draft" preview on streaming channels)                      │
   └─────────────────────────────────────────────────────────────────────┘
```

**The single most important fact:** OpenClaw does **not** implement the model→tool loop
itself. That loop is owned by an external package, **`@earendil-works/pi-coding-agent`**
("pi-agent-core"). OpenClaw wraps it: it assembles the system prompt + tools, calls
`session.prompt(...)`, and **bridges pi-agent-core's event stream** back into its own
streams (assistant deltas, tool start/end, lifecycle). Everything else — routing,
sessions, queueing, retries, compaction, delivery — is OpenClaw.

---

## 1. Phase 1 — Routing an inbound message to the agent

### 1a. The call chain (channel inbound → agent invocation)

```
src/plugin-sdk/channel-ingress-runtime.ts          (channel ingress entry, re-exported)
  → src/auto-reply/dispatch.ts                      dispatchInboundMessage()        (~:379)
      → withReplyDispatcher() + dispatchReplyFromConfig()
  → src/auto-reply/reply/dispatch-from-config.ts    dispatchReplyFromConfig()       (~:787)
      → replyResolver(ctx, …)                                                        (~:2041)
  → src/auto-reply/reply/get-reply.ts               getReplyFromConfig()            (~:206)
      → runPreparedReply()                                                           (~:582)
  → src/auto-reply/reply/get-reply-run.ts           runPreparedReply()              (~:389)
      → runReplyAgent()                                                              (~:1199)
  → src/auto-reply/reply/agent-runner.ts            runReplyAgent()                 (~:1021)
      → runPreflightCompactionIfNeeded() / runMemoryFlushIfNeeded()
      → runAgentTurnWithFallback()                                                   (~:1466)
  → src/auto-reply/reply/agent-runner-execution.ts  runAgentTurnWithFallback()      (~:1236)
      → runEmbeddedPiAgent({...})   ◄── THE AGENT IS INVOKED HERE                    (~:1971)
  → src/agents/pi-embedded.ts → src/agents/pi-embedded-runner/run.ts                 (Phase 2)
```

Notable middle steps before the model ever runs:
- **Native slash commands** (`/new`, `/reset`, `/think`, …) are intercepted as a fast path in `get-reply.ts` (~:297) before any agent run.
- **Preflight compaction** and **memory flush** (`agent-runner.ts` ~:1331/~:1352) run *before* the turn so the transcript fits the context window.
- **Fallback wrapper** (`runAgentTurnWithFallback`) handles provider/model failover around the actual `runEmbeddedPiAgent` call.

### 1b. Dedup + debounce (don't run twice)

`src/auto-reply/reply/inbound-dedupe.ts`:
- `buildInboundDedupeKey()` (~:56) — key = `provider/messageId/peerId/sessionScope/accountId/threadId`.
- `claimInboundDedupe()` (~:94) marks in-flight; `commitInboundDedupe()` (~:114) records after the run; `releaseInboundDedupe()` (~:124) clears it.
- Global `inboundDedupeCache` (~:23): TTL ~20 min, ≤5000 entries; plus an in-flight `Set`.
This stops channel redeliveries (after reconnects) from launching duplicate agent runs.

### 1c. Session key resolution (which conversation)

`src/routing/session-key.ts` → `buildAgentPeerSessionKey()` (~:197). The key decides which
transcript/session the message joins:

| Source | sessionKey pattern |
|---|---|
| DM, `dmScope:"main"` (default) | `agent:<agentId>:main` |
| DM, `dmScope:"per-peer"` | `agent:<agentId>:direct:<peerId>` |
| DM, `dmScope:"per-channel-peer"` | `agent:<agentId>:<channel>:direct:<peerId>` |
| DM, `dmScope:"per-account-channel-peer"` | `agent:<agentId>:<channel>:<accountId>:direct:<peerId>` |
| Group | `agent:<agentId>:<channel>:group:<peerId>` |
| Channel/room | `agent:<agentId>:<channel>:channel:<peerId>` |

`resolveAgentIdFromSessionKey()` (~:116) extracts the agent id (defaults to `main`). The
session key is also what serializes runs (next).

### 1d. Queue / lane serialization (one run per session at a time)

- **Per-session followup queue:** `src/auto-reply/reply/queue/enqueue.ts` → `enqueueFollowupRun()` (~:66), `getFollowupQueue(key)` (~:77). Messages arriving during an active run are queued/steered per `sessionKey`, with a drop/interrupt/summarize policy (~:90–110) and a recent-message-id dedupe cache (5 min).
- **Global lanes:** `src/process/lanes.ts` defines `CommandLane = main | cron | cron-nested | subagent | nested`; `src/process/command-queue.ts` tracks per-lane depth (`getQueueSize(lane)`), used e.g. to defer heartbeats when a lane is busy.

Net effect: runs are serialized **per session** and capped **per global lane**, preventing
tool/transcript races.

### 1e. The inbound gate order — everything that can stop a message before the agent

A message passes through a series of gates; **each one can drop, defer, fast-path, or
transform it before a model run ever starts.** In rough order:

| # | Gate | What it does | Where (real code) |
|---|---|---|---|
| 1 | **Transport auth** | Did the request even reach the channel legitimately? (per-channel — e.g. WhatsApp's paired session, MS Teams' Bot Framework **JWT**, a webhook secret). Fails closed. | each channel plugin (`extensions/<id>/…`) |
| 2 | **Sender authorization (security model)** | Is *this sender* allowed to talk to the agent? `dmPolicy` (`open`/`allowlist`/`pairing`/`disabled`) + `allowFrom`. Unknown sender under `pairing` → a pairing code is issued and the message is **not processed** until approved. | `src/channels/allow-from.ts` (`isSenderIdAllowed`), pairing in `src/pairing/**` + channel pairing adapters |
| 3 | **Dedupe** | Same platform message redelivered (reconnect)? Dropped. | `src/auto-reply/reply/inbound-dedupe.ts` (`buildInboundDedupeKey`, `claimInboundDedupe`) |
| 4 | **Debounce / coalesce** | Rapid consecutive messages from the same sender are merged into one turn (so a 3-line burst isn't 3 runs). | `src/auto-reply/inbound-debounce.ts` (`debounceMs` ← `messages.inbound.debounceMs`) |
| 5 | **Slash-command fast path** | `/new`, `/reset`, `/think`, `/status`, `/allowlist`, … are handled **without the model** and return early. | `src/auto-reply/command-detection.ts`, `commands-registry.ts`; intercepted in `get-reply.ts` (~:297) |
| 6 | **Activation / mention gating** | In groups/channels, only act when addressed (e.g. require an @mention) per `activation mention|always`. | `src/auto-reply/command-gating.ts` + per-channel `requireMention` (e.g. `extensions/whatsapp/src/group-policy.ts`) |
| 7 | **Queue / steer** | If a run is already active for this session, decide how the new message joins it — `steer` (inject into the running turn), `followup` (run after), `collect` (coalesce into one later turn), or `interrupt` (abort + run newest). | `src/auto-reply/reply/queue/normalize.ts` + `directive.ts` + `drain.ts`; `interrupt` in `abort-primitives.ts` |
| 8 | **→ Agent run** | Only a message that survives all of the above starts `runEmbeddedPiAgent`. | `src/auto-reply/reply/agent-runner-execution.ts` |

Outcomes, summarized:
- **Dropped** → dedupe hit, `dmPolicy:"disabled"`, or not allowlisted under `allowlist`.
- **Held / answered out-of-band** → `pairing` issues a code; the sender must be approved first.
- **Answered without the model** → slash-command fast path.
- **Merged** → debounce (same sender, rapid) or `collect` (during an active run).
- **Deferred / steered** → `followup` / `steer` / `interrupt` when a run is in flight.
- **Run** → everything else reaches the agent.

> This is why "the agent ran" is the *exception path*, not the default: most of the inbound
> machinery exists to decide whether a model turn should happen **at all**, and in what
> session — treating inbound DMs as untrusted input throughout.

---

## 2. Phase 2 — The agentic runtime (running the agent)

### 2a. `runEmbeddedPiAgent` — the orchestrator
`src/agents/pi-embedded-runner/run.ts` → `runEmbeddedPiAgent()` (~:407). In order:

1. **Resolve session key + lanes early** (~:410–451) so hooks/compaction/LCM all get a key.
2. **Resolve model + auth profile** (~:550–689): provider/model (optionally via a hook),
   `ensureAuthProfileStore`, then `resolveModelAsync()` with model-fallback discovery.
3. **Build the runtime plan** (`buildAgentRuntimePlan`, ~:1356) — provider, model, auth, thinking level, stream params.
4. **Retry/attempt loop** (~:1287, `while`): each iteration runs one attempt through the
   lanes with timeout enforcement (`runEmbeddedAttemptWithBackend`, ~:1404), handling auth
   rotation, model fallback, and compaction retries; accumulates usage.
5. **Timeout + cost-runaway breaker** (~:424–436, ~:1595–1640): a lane timeout plus an
   idle-timeout circuit breaker that survives across attempts (stops endless no-progress loops).

### 2b. `runEmbeddedAttempt` — one model attempt
`src/agents/pi-embedded-runner/run/attempt.ts` → `runEmbeddedAttempt()`:

- **Prepare** (~:1550–2260): workspace, plugins, bootstrap context, skills; **assemble the
  system prompt** (`buildAttemptSystemPrompt`, ~:2160); **acquire the session write lock**;
  open `SessionManager.open(sessionFile)` (~:2301, loads the JSONL transcript).
- **Create the agent session** (~:2563): `createAgentSession()` from
  `@earendil-works/pi-coding-agent`, wiring `activeSession.agent.streamFn` (the model transport).
- **Wrap the stream fn** (~:2879–3088): provider text transforms, prompt-cache tracing,
  Anthropic stream recovery, tool-result sanitization.
- **Subscribe to pi events** (~:3432): `subscribeEmbeddedPiSession(...)` (see 2d).
- **Invoke the model / enter the loop** (~:3415):
  ```ts
  return await abortable(trackPromptSettlePromise(activeSession.prompt(prompt, options)));
  ```
  wrapped in `withOwnedSessionTranscriptWrites(...)` so transcript writes stay safe.

### 2c. The actual loop (model → tools → repeat) lives in pi-agent-core
`activeSession.prompt()` hands control to **`@earendil-works/pi-coding-agent`**
(`SessionManager`). That package runs the loop:

```
session.prompt(text)
  └─ streamFn(model, {messages, systemPrompt, tools}, options)
       ├─ model streams assistant tokens          → emits message_start / message_update / message_end
       └─ model emits tool calls                  → emits tool_execution_start
              └─ OpenClaw runs the tool (runToolLifecycle) → emits tool_execution_end
       ↑ repeat: tool results feed back into the model until it stops (stop reason / max turns)
  └─ persists every message + tool to the JSONL transcript
```

So OpenClaw provides the **tools, the system prompt, the transcript, and the transport**;
pi-agent-core decides **when to call tools and when to stop**. (Other harnesses exist —
e.g. Codex — selected via `src/agents/harness/selection.ts`; the embedded "pi" harness is
the built-in default, `harness/builtin-pi.ts`.)

### 2d. `subscribeEmbeddedPiSession` — bridging pi events → OpenClaw streams
`src/agents/pi-embedded-subscribe.ts` (~:126) + `pi-embedded-subscribe.handlers.ts`. Events
are scheduled **sequentially** to keep transcript order. The mapping:

| pi-agent-core event | OpenClaw callback / stream |
|---|---|
| `message_start` | `onAssistantMessageStart` (begin delta buffer) |
| `message_update` | delta accumulation → `onPartialReply` / `onBlockReply` / `onReasoningStream` |
| `message_end` | final assistant text + usage + reasoning end |
| `tool_execution_start` | `onToolResult` start + metadata |
| `tool_execution_update` | tool progress → subscribers |
| `tool_execution_end` | tool result (markdown/plain) + media URLs + errors (runs detached) |
| `agent_start` / `agent_end` | lifecycle `start` / `end` (+ final metrics) |
| `compaction_start` / `compaction_end` | context compaction begin / result (+ retry decision) |

These callbacks are what Phase 3 turns into outbound chat messages.

### 2e. Tool execution
`runToolLifecycle()` (in `attempt.ts` ~:3514) executes the tool:
`toolParams.tool.execute(toolCallId, input, signal, onUpdate)`, guarded by the abort signal,
the session write lock, and result middleware (sanitize/truncate). `before_tool_call` /
`after_tool_call` hooks fire around it. Media URLs are filtered (trusted-local vs external).

### 2f. System prompt / context assembly
`src/agents/pi-embedded-runner/run/attempt-system-prompt.ts` → `buildAttemptSystemPrompt()`
(~:50), which calls `buildEmbeddedSystemPrompt()` (`system-prompt.ts`). It assembles:
OpenClaw base instructions + **tools schema** + **skills prompt** + **bootstrap/workspace
context files** (AGENTS.md, SOUL.md, etc.) + provider guidance + sandbox/memory sections,
then applies provider-specific transforms (`transformProviderSystemPrompt`). A
`systemPromptOverride()` lets it be augmented mid-turn (e.g. after compaction).

### 2g. Session write lock
`src/agents/session-write-lock.ts`. Held across message persistence, compaction, and
mid-turn recovery. The transcript is a JSONL file (`SessionManager.open/prompt`); the lock is
process-aware so it catches writers from other processes too. (This is the same
`session.writeLock.*` surface modeled in the daemon-internals doc.)

---

## 3. Phase 3 — Sending the response back to the chat

The subscribe callbacks (2d) feed a reply dispatcher that normalizes → filters → chunks →
routes → sends.

### 3a. Assemble + normalize the reply
`src/auto-reply/reply/normalize-reply.ts` → `normalizeReplyPayload()` (~:35):
- strip exact **`NO_REPLY`** silent token (suppress entirely) (~:58);
- strip trailing/leading silent tokens from mixed content (~:68) and `HEARTBEAT_OK` markers (~:87);
- prepend an optional `responsePrefix` (~:120); drop empty payloads.

### 3b. Silent-reply (`NO_REPLY`) filtering
`src/auto-reply/tokens.ts`: `SILENT_REPLY_TOKEN = "NO_REPLY"` (~:4). `isSilentReplyText()`
(~:32), `isSilentReplyPayloadText()` (also matches `{"action":"NO_REPLY"}`, ~:74),
`stripSilentToken()` / `stripLeadingSilentToken()`, and `startsWithSilentToken()` (catches a
streaming fragment like `"NO"` early). In `reply-dispatcher.ts` (~:156) a payload that
normalizes to null is **never delivered** — that's how the agent "stays silent."

### 3c. Serialized delivery
`src/auto-reply/reply/reply-dispatcher.ts` → `enqueue()` (~:156): keeps tool/block/final
payloads **in order**, runs a `message_sending` (beforeDeliver) hook, inserts a human-like
delay between blocks, then calls `dispatcher.deliver(payload, {kind})`.

### 3d. Chunking to channel limits
`src/auto-reply/chunk.ts`: `resolveTextChunkLimit()` (~:55, default 4000), `resolveChunkMode()`
(~:99, `"length"` or `"newline"`), `chunkByNewline()` / `chunkByParagraph()` (prefer
paragraph/blank-line boundaries, respect markdown fences). Limits are per-channel/per-account.

### 3e. Outbound send via the channel adapter
`src/infra/outbound/deliver.ts`: `createChannelHandler()` / `createPluginHandler()` (~:220)
load the channel plugin's outbound adapter and produce `sendText` / `sendMedia` / `sendPayload`
that call the platform (`outbound.sendText(...)` ~:491). Results normalize to
`OutboundDeliveryResult` (messageId, receipt, metadata).

### 3f. Routing back to the *originating* peer
`src/auto-reply/reply/route-reply.ts` → `routeReply()` (~:93). Replies go to where the
inbound came from, not the "last used" channel. The routing identity (`dispatch.ts` ~:60,
`createChannelOutboundContextBase` ~:563) carries:
`SessionKey`, `OriginatingChannel`/`Surface`/`Provider`, `OriginatingTo`/`NativeChannelId`,
`accountId`, `threadId`/`replyToId`. So the message lands in the exact chat/thread/account.

### 3g. Streaming "draft" preview (live editing)
`src/channels/draft-stream-loop.ts` → `createDraftStreamLoop()` (~:10): for streaming-capable
channels (Telegram/Discord/Slack) it **edits one preview message repeatedly** as tokens
arrive, throttled (`throttleMs`) to respect rate limits; on completion the draft is finalized
into the real message (`draft-preview-finalizer.ts` → `deliverFinalizableDraftPreview`).
Modes from `src/plugin-sdk/channel-streaming.ts`: `off | partial | block | progress`
(`resolveChannelPreviewStreamMode` ~:696). Non-streaming channels accumulate text and send
once at the end. Block streaming sends intermediate tool/code blocks as separate messages.

---

## 4. End-to-end (one message, start to finish)

```
channel inbound {channel, from, text}
  │  dedupe (inbound-dedupe.ts) · debounce
  │  session key (routing/session-key.ts) → agent:<id>:…
  │  enqueue per session lane (queue/enqueue.ts) + global lane (process/lanes.ts)
  ▼
dispatchReplyFromConfig → getReplyFromConfig → runReplyAgent → runAgentTurnWithFallback
  ▼
runEmbeddedPiAgent (pi-embedded-runner/run.ts)
  ├─ resolve model + auth profile + plan
  ├─ acquire session write lock · SessionManager.open(transcript.jsonl)
  ├─ buildAttemptSystemPrompt (tools + skills + bootstrap files + provider transforms)
  ├─ subscribeEmbeddedPiSession (bridge events)
  └─ activeSession.prompt(text)              ◄── pi-agent-core owns this loop
        model → (tool_execution_start → runToolLifecycle → tool_execution_end) → repeat → done
              events → onPartialReply / onBlockReply / onToolResult / lifecycle
  ▼
reply pipeline (auto-reply/reply/**)
  ├─ normalizeReplyPayload   (strip NO_REPLY / HEARTBEAT, prefix)
  ├─ reply-dispatcher.enqueue (ordered, beforeDeliver hook, human delay)
  ├─ chunk.ts                (split to channel limit)
  ├─ routeReply              (→ OriginatingChannel / OriginatingTo / threadId)
  └─ infra/outbound/deliver  (channel.sendText/sendMedia)   ── (+ live draft preview)
  ▼
message delivered to the same conversation/peer
```

---

## 5. Key takeaways (for porting / mental model)

1. **OpenClaw orchestrates; pi-agent-core runs the loop.** The model→tool→repeat cycle is in
   `@earendil-works/pi-coding-agent`. OpenClaw supplies tools + system prompt + transcript +
   transport, then **subscribes to events**.
2. **The session key is the spine.** It picks the transcript, serializes runs (per-session
   lane), and routes replies back (originating channel/peer carried alongside it).
3. **Inbound is gated before the agent** (see **§1e** for the full ordered list): transport
   auth → sender authorization (`dmPolicy`/`allowFrom`/pairing) → dedupe → debounce →
   slash-command fast path → activation/mention gating → queue/steer — only a message that
   survives all of these starts a model run.
4. **Outbound is a pipeline, not a single send:** normalize → `NO_REPLY` filter → chunk →
   route-to-origin → deliver, with optional **live draft editing** on streaming channels.
5. **`NO_REPLY`** is how the agent chooses silence — a normalized-to-null payload is simply
   never delivered.

---

## 6. File reference (the agent layer)

| Concern | File | Key symbol |
|---|---|---|
| Inbound dispatch entry | `src/auto-reply/dispatch.ts` | `dispatchInboundMessage` |
| Config-driven reply | `src/auto-reply/reply/dispatch-from-config.ts` | `dispatchReplyFromConfig` |
| Reply resolver | `src/auto-reply/reply/get-reply.ts` / `get-reply-run.ts` | `getReplyFromConfig`, `runPreparedReply` |
| Agent runner | `src/auto-reply/reply/agent-runner.ts` / `-execution.ts` | `runReplyAgent`, `runAgentTurnWithFallback` |
| Inbound dedupe | `src/auto-reply/reply/inbound-dedupe.ts` | `buildInboundDedupeKey`, `claimInboundDedupe` |
| Session key | `src/routing/session-key.ts` | `buildAgentPeerSessionKey` |
| Per-session queue | `src/auto-reply/reply/queue/enqueue.ts` | `enqueueFollowupRun` |
| Global lanes | `src/process/lanes.ts`, `src/process/command-queue.ts` | `CommandLane`, `getQueueSize` |
| **Agent orchestrator** | `src/agents/pi-embedded-runner/run.ts` | `runEmbeddedPiAgent` |
| Single attempt | `src/agents/pi-embedded-runner/run/attempt.ts` | `runEmbeddedAttempt` |
| **The loop (external)** | `@earendil-works/pi-coding-agent` | `SessionManager`, `session.prompt` |
| Event bridge | `src/agents/pi-embedded-subscribe.ts` (+ `.handlers.ts`) | `subscribeEmbeddedPiSession` |
| System prompt | `src/agents/pi-embedded-runner/run/attempt-system-prompt.ts` | `buildAttemptSystemPrompt` |
| Session write lock | `src/agents/session-write-lock.ts` | `acquireSessionWriteLock` |
| Reply normalize | `src/auto-reply/reply/normalize-reply.ts` | `normalizeReplyPayload` |
| Silent token | `src/auto-reply/tokens.ts` | `SILENT_REPLY_TOKEN`, `isSilentReplyText` |
| Reply dispatcher | `src/auto-reply/reply/reply-dispatcher.ts` | `enqueue` |
| Chunking | `src/auto-reply/chunk.ts` | `chunkByNewline`, `resolveTextChunkLimit` |
| Outbound deliver | `src/infra/outbound/deliver.ts` | `createPluginHandler`, `createChannelOutboundContextBase` |
| Route to origin | `src/auto-reply/reply/route-reply.ts` | `routeReply` |
| Streaming draft | `src/channels/draft-stream-loop.ts` | `createDraftStreamLoop` |
| Streaming modes | `src/plugin-sdk/channel-streaming.ts` | `resolveChannelPreviewStreamMode` |

---

### Source

Traced from `/Users/rajendra/projects/openclaw/openclaw/src` — `auto-reply/**`,
`routing/**`, `process/**`, `agents/pi-embedded*/**`, `infra/outbound/**`, `channels/draft-*`,
`plugin-sdk/channel-streaming.ts`. The model→tool loop itself is in the external
`@earendil-works/pi-coding-agent` package.
