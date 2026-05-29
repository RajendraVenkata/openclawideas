# Microsoft Teams — Setup over WebSocket

**Short answer:** You can run the **OpenClaw side** of Teams setup over WebSocket — `config.patch` to write `channels.msteams.*`, `channels.start` to bring it up, `channels.status` to verify. The **Microsoft side** (Azure Bot resource, Entra ID app, Teams app manifest, RSC permissions, admin consent, tunnel creation) **cannot** happen over the Gateway WS — it has to be done in Azure / Teams Admin / `teams.cli` / Azure Portal before you can configure anything.

This is no different from any other channel that requires a third-party app registration (Slack, Discord, WhatsApp QR all have an "external side" step too). What's different about Teams is the external side has *more* steps and they're done in Microsoft's tooling, not OpenClaw's.

Grounded in:
- `docs/channels/msteams.md` — full config + auth surface
- `docs/gateway/protocol.md` — WS protocol
- `src/gateway/methods/core-descriptors.ts` — method names + scopes
- `src/gateway/protocol/schema/channels.ts`, `config.ts` — exact param schemas

If something isn't in those files, I haven't included it.

---

## 1. What's in scope for WebSocket vs what isn't

| Step | Where it happens | WS-callable? |
|---|---|---|
| Create Azure Bot resource | Azure Portal or `teams app create` | ❌ external |
| Generate `appId` / `appPassword` / `tenantId` | Azure / `teams.cli` | ❌ external |
| Build and upload Teams app manifest (zip with icons) | Teams Admin Center / `teams.cli` | ❌ external |
| Configure RSC permissions in manifest | Manifest file / `teams app rsc add` | ❌ external |
| Grant admin consent for Graph permissions | Entra ID Portal | ❌ external |
| Set messaging endpoint URL on the Bot resource | Azure Portal / `teams app update --endpoint` | ❌ external |
| Stand up a public HTTPS endpoint (tunnel / load balancer) | devtunnel / ngrok / your infra | ❌ external |
| **Write `channels.msteams.*` config** | OpenClaw Gateway | ✅ `config.patch` |
| **Start / stop / status the channel runtime** | OpenClaw Gateway | ✅ `channels.{start,stop,status}` |
| **Multi-agent bindings for Teams traffic** | OpenClaw Gateway | ✅ `config.patch` + `agents.create` |
| **Read live status / errors / connect time** | OpenClaw Gateway | ✅ `channels.status { probe: true }` |
| **Inspect channel config schema** | OpenClaw Gateway | ✅ `config.schema.lookup` |

So a WS-driven control plane can fully own the OpenClaw configuration of an MS Teams channel once the Bot Framework credentials exist. The "first-time-ever Azure setup" still needs human or Azure-API work.

---

## 2. The exact WS methods you'll call

From `src/gateway/methods/core-descriptors.ts`:

| Method | Scope | Use |
|---|---|---|
| `config.schema.lookup` | `operator.read` | Read schema slice for `channels.msteams` |
| `config.get` | `operator.read` | Snapshot current config |
| `config.patch` | `operator.admin` (controlPlaneWrite) | Write Teams config |
| `channels.status` | `operator.read` | Live status + audits |
| `channels.start` | `operator.admin` | Start the Teams runtime |
| `channels.stop` | `operator.admin` | Stop it |
| `channels.logout` | `operator.admin` | Clear stored auth |
| `agents.create` | `operator.admin` | Create an isolated agent for Teams |
| `agents.list` | `operator.read` | Confirm agents |

The frame shape is the same as any other WS RPC (see `openclaw-gateway-websocket-setup.md` in this folder for the connect handshake):

```json
{ "type":"req", "id":"<uuid>", "method":"<name>", "params": { ... } }
```

Param schemas straight from `src/gateway/protocol/schema/channels.ts`:

```ts
// channels.start / channels.stop / channels.logout
{ channel: string, accountId?: string }

// channels.status
{ probe?: boolean, timeoutMs?: integer (>=0), channel?: string }

// config.patch  (raw is a JSON5 STRING)
{ raw: string, baseHash?: string, sessionKey?: string,
  deliveryContext?: { ... }, note?: string,
  restartDelayMs?: integer (>=0) }
```

---

## 3. Prerequisite — get the Microsoft-side artifacts first

Before any WS call, you need:

- `appId` (= Entra ID App Client ID = Azure Bot App ID)
- `appPassword` (= client secret) **OR** federated auth setup (certificate path or managed identity)
- `tenantId`
- A public HTTPS endpoint that resolves to your Gateway's `webhook.port` (default `3978`) at the `webhook.path` (default `/api/messages`)
- The Teams app installed in at least one user / team / group chat so traffic can actually arrive

How to get these (from `docs/channels/msteams.md`): use the `@microsoft/teams.cli` (preview) or the Azure Portal manual path. The repo's two-path documentation is mirrored in the manual-setup doc next to this one — see `openclaw-msteams-manual-setup.md`.

The reason these can't be WS-driven: they're Microsoft Cloud operations. The OpenClaw Gateway is a consumer of the credentials, not a generator of them.

---

## 4. End-to-end WS workflow (client-secret auth)

The minimal case: you have `appId` / `appPassword` / `tenantId`, the Teams app is installed, the endpoint is reachable. Drive the OpenClaw side over WS:

```typescript
import { OpenClaw } from "@openclaw/sdk";

const oc = new OpenClaw({
  url: "ws://127.0.0.1:18789",
  token: process.env.OPENCLAW_GATEWAY_TOKEN,
});
await oc.connect();

// 1. (Optional) inspect schema before writing
const schema = await oc.rawRequest("config.schema.lookup",
  { path: "channels.msteams" });

// 2. Patch in the Teams config
const patch = JSON.stringify({
  channels: {
    msteams: {
      enabled: true,
      appId:       "<CLIENT_ID>",
      appPassword: "<CLIENT_SECRET>",
      tenantId:    "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },

      // Access policy — same patterns as other channels
      dmPolicy: "pairing",            // pairing | allowlist | open | disabled
      allowFrom: [
        "00000000-0000-0000-0000-000000000000", // AAD object id
        "accessGroup:core-team",
      ],

      groupPolicy: "allowlist",
      groupAllowFrom: [
        "00000000-0000-0000-0000-000000000000",
        "accessGroup:core-team",
      ],

      // Reply style for Posts vs Threads channels
      replyStyle: "thread",

      // Optional: limit which teams/channels can reach the bot
      teams: {
        "19:abc...@thread.tacv2": {
          channels: {
            "19:xyz...@thread.tacv2": { requireMention: true },
          },
        },
      },
    },
  },
});
await oc.rawRequest("config.patch", { raw: patch });

// 3. Start the Teams runtime
await oc.rawRequest("channels.start", { channel: "msteams" });

// 4. Verify with a live probe
const status = await oc.rawRequest("channels.status",
  { channel: "msteams", probe: true, timeoutMs: 5000 });
console.log(status.channelAccounts.msteams);
// → [{ accountId: "default", configured: true, running: true,
//      connected: <bool>, lastError?: ..., ... }]
```

---

## 5. End-to-end WS workflow (federated certificate auth)

For production deployments that use a PEM cert instead of a shared secret.

> Prerequisite: cert generated, public part uploaded to Entra ID → App Registration → **Certificates & secrets**, private cert deployed to the Gateway host filesystem.

```typescript
await oc.rawRequest("config.patch", {
  raw: JSON.stringify({
    channels: {
      msteams: {
        enabled:  true,
        appId:    "<APP_ID>",
        tenantId: "<TENANT_ID>",
        authType: "federated",
        certificatePath: "/path/to/cert.pem",
        webhook: { port: 3978, path: "/api/messages" },
        // … access policies …
      },
    },
  }),
});
await oc.rawRequest("channels.start", { channel: "msteams" });
```

The doc's auth-type matrix applies — federated lives in the same config tree, same WS surface.

---

## 6. End-to-end WS workflow (managed identity auth)

For AKS / App Service / Azure VM deployments. The pod's managed identity is linked to the Entra ID app via a federated identity credential. No secret crosses the wire.

```typescript
// System-assigned managed identity
await oc.rawRequest("config.patch", {
  raw: JSON.stringify({
    channels: {
      msteams: {
        enabled:  true,
        appId:    "<APP_ID>",
        tenantId: "<TENANT_ID>",
        authType: "federated",
        useManagedIdentity: true,
        // Add managedIdentityClientId for user-assigned MI:
        // managedIdentityClientId: "<MI_CLIENT_ID>",
        webhook: { port: 3978, path: "/api/messages" },
      },
    },
  }),
});
await oc.rawRequest("channels.start", { channel: "msteams" });
```

Network requirement (from `docs/channels/msteams.md`): the pod/VM needs egress to IMDS `169.254.169.254:80`. If you're behind a NetworkPolicy, add the egress rule there — that's an out-of-band step, not a WS call.

---

## 7. Multi-agent / per-team routing over WS

Same surface as the other channels — create an agent, then bind:

```typescript
// Create an isolated agent for the Teams "engineering" team
await oc.rawRequest("agents.create", {
  name: "engineering",
  workspace: "~/.openclaw/workspace-engineering",
  model: "anthropic/claude-sonnet-4-6",
});

// Route a specific Teams team to it
await oc.rawRequest("config.patch", {
  raw: JSON.stringify({
    bindings: [
      // Default Teams traffic goes to "main"
      { agentId: "main",
        match:   { channel: "msteams", accountId: "*" } },
      // …but this team is handled by the engineering agent
      { agentId: "engineering",
        match:   {
          channel: "msteams",
          peer:    { kind: "group", id: "19:abc...@thread.tacv2" }
        } },
    ],
  }),
});

// Verify
console.log(await oc.rawRequest("agents.list", {}));
```

The binding tier order (from `docs/channels/channel-routing.md`) is most-specific-wins: peer > parent peer > guild+roles > guild > team > account > channel-wide > default. So the `peer: { kind: "group", id: ... }` binding above wins over the channel-wide `accountId: "*"` one.

---

## 8. Day-2 operations over WS

```typescript
// Stop the Teams runtime (config stays intact)
await oc.rawRequest("channels.stop",   { channel: "msteams" });
await oc.rawRequest("channels.start",  { channel: "msteams" });

// Clear stored Teams auth state for this account
await oc.rawRequest("channels.logout", { channel: "msteams" });

// Rotate the secret without downtime: patch new appPassword, then restart channel
await oc.rawRequest("config.patch", {
  raw: JSON.stringify({
    channels: { msteams: { appPassword: "<NEW_SECRET>" } },
  }),
});
await oc.rawRequest("channels.stop",  { channel: "msteams" });
await oc.rawRequest("channels.start", { channel: "msteams" });

// Live diagnostic snapshot
const live = await oc.rawRequest("channels.status",
  { channel: "msteams", probe: true, timeoutMs: 8000 });
// channelAccounts.msteams[].lastError, lastInboundAt, lastOutboundAt, etc.
```

The `channels.status` result shape from `src/gateway/protocol/schema/channels.ts` gives you `accountId`, `enabled`, `configured`, `linked`, `running`, `connected`, `reconnectAttempts`, `lastConnectedAt`, `lastError`, `healthState`, `lastInboundAt`, `lastOutboundAt`, `lastTransportActivityAt`, `dmPolicy`, `allowFrom`, `baseUrl` — all you need to drive a status dashboard from your control plane.

---

## 9. The full setup picture

```mermaid
sequenceDiagram
    autonumber
    participant Ops as Operator / Control plane
    participant Az as Azure / Entra ID
    participant TC as @microsoft/teams.cli<br/>(or Azure Portal)
    participant Tn as Public tunnel<br/>devtunnel / LB
    participant App as Your WS client
    participant GW as OpenClaw Gateway

    Note over Ops,TC: One-time, OUT OF BAND
    Ops->>Az: Create Azure Bot + Entra ID app
    Az-->>Ops: appId · appPassword · tenantId
    Ops->>TC: Build/upload Teams app manifest<br/>(bot scopes, RSC perms)
    Ops->>Tn: Stand up public HTTPS endpoint
    Ops->>Az: Set messaging endpoint to <br/>https://&lt;tunnel&gt;/api/messages

    Note over App,GW: Now WS-driven
    App->>GW: req connect (operator.admin)
    GW-->>App: res hello-ok
    App->>GW: req config.schema.lookup<br/>{ path: "channels.msteams" }
    GW-->>App: res schema slice
    App->>GW: req config.patch<br/>{ raw: "{channels.msteams: {...}}" }
    GW-->>App: res ok
    App->>GW: req channels.start { channel: "msteams" }
    GW-->>App: res { started: true }
    App->>GW: req channels.status { probe: true }
    GW-->>App: res snapshot

    Note over App,GW: Inbound message flow
    GW-->>App: event sessions.changed (first message arrives)
```

The take-away: every "OpenClaw box" arrow above is a WS call. Every "Azure / Microsoft" arrow above is **not**.

---

## 10. What you can NOT do over WebSocket

To be explicit so nothing's invented:

1. **Generate `appPassword`** — only Azure can issue a client secret.
2. **Upload / modify the Teams app manifest** — done through Teams Admin Center or `teams.cli`.
3. **Add RSC permissions or Graph App permissions** — done in the Teams manifest + Entra ID, requires admin consent.
4. **Change the Bot Framework messaging endpoint URL** — that's set on the Azure Bot resource, not in OpenClaw config.
5. **Approve a pending OpenClaw channel-side DM pairing request** — for the same reason flagged in the WhatsApp/Telegram WS doc: `openclaw pairing approve` is a local CLI op, not a public RPC. Workaround: use `dmPolicy: "allowlist"` with explicit `allowFrom` from the start, which IS WS-driven.
6. **Grant admin consent in Entra ID** — Microsoft tenant admin action.

Everything else — credentials placement, access policies, per-team overrides, reply style, federation type, agent bindings, channel lifecycle, status reads — is fully WS-driven.

---

## 11. Raw WS / non-Node example

After the standard `connect` handshake (see the gateway-websocket doc):

```python
patch = json.dumps({
    "channels": {
        "msteams": {
            "enabled":     True,
            "appId":       "<CLIENT_ID>",
            "appPassword": "<CLIENT_SECRET>",
            "tenantId":    "<TENANT_ID>",
            "webhook":     {"port": 3978, "path": "/api/messages"},
            "dmPolicy":    "pairing",
            "groupPolicy": "allowlist",
            "groupAllowFrom": [
              "00000000-0000-0000-0000-000000000000",
              "accessGroup:core-team",
            ],
        }
    }
})

await rpc("config.patch", {"raw": patch})
await rpc("channels.start", {"channel": "msteams"})
print(await rpc("channels.status",
                {"channel": "msteams", "probe": True}))
```

`raw` is a JSON5 string. That's the contract from the source schema, not negotiable.

---

## 12. The one-paragraph summary

The OpenClaw side of Microsoft Teams setup is entirely WS-driven: connect with `operator.admin` scope, call `config.patch` with `{ raw: "<JSON5 of channels.msteams.*>" }` to write the bot credentials (client-secret, certificate, or managed-identity flavors), policies (`dmPolicy`, `groupPolicy`, `allowFrom`, `groupAllowFrom`, per-team allowlists), reply style and webhook details, then `channels.start { channel: "msteams" }` to bring the runtime up and `channels.status { probe: true }` to confirm. Multi-agent routing uses `agents.create` + another `config.patch` for `bindings`, same as any other channel. What WS cannot do is the Azure / Entra ID / Teams Admin work — generating `appId` / `appPassword` / `tenantId`, building and uploading the Teams app manifest, configuring RSC and Graph permissions, granting admin consent, setting the messaging endpoint URL on the Azure Bot resource, standing up the public HTTPS tunnel. Those happen via `@microsoft/teams.cli` or the Azure Portal before the WS calls. Once the credentials and the Teams app exist, the OpenClaw control plane never has to leave WebSocket again.

---

## 13. Source map

- `docs/channels/msteams.md` — config keys, auth modes, capabilities
- `docs/gateway/protocol.md` — WS protocol contract
- `src/gateway/methods/core-descriptors.ts` — method names + scopes
- `src/gateway/protocol/schema/channels.ts` — exact param schemas for `channels.*`
- `src/gateway/protocol/schema/config.ts` — `config.patch` param schema
- `docs/channels/channel-routing.md` — binding tier order
- Companion docs in this folder:
  - `openclaw-gateway-websocket-setup.md` — generic WS handshake + frame model
  - `openclaw-channels-via-websocket.md` — same surface applied to Telegram + WhatsApp
  - `openclaw-msteams-manual-setup.md` — the out-of-band Microsoft side
