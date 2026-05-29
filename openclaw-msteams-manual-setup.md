# Microsoft Teams — Manual Setup

Grounded in `/Users/rajendra/projects/openclaw/openclaw/docs/channels/msteams.md` (1,042 lines) and `extensions/msteams/`. Every command, config key, and permission name below comes from those files. Where the doc shows two paths (Teams CLI vs Azure Portal manual), both are included; where the doc says something explicit (e.g. *"Creation of new multi-tenant bots was deprecated after 2025-07-31"*), it's quoted.

Microsoft Teams ships as a **bundled plugin** in current OpenClaw releases — no separate install required in normal packaged builds.

---

## 1. What you're building

Teams talks to OpenClaw over the **Microsoft Bot Framework**: Teams sends webhook traffic to a public HTTPS endpoint on your machine. The OpenClaw Gateway hosts that endpoint at `POST /api/messages` on `webhook.port` (default `3978`). So you need:

1. An **Entra ID (Azure AD) app registration** + an **Azure Bot resource** — gives you `appId`, `appPassword`, `tenantId`.
2. A **Teams app manifest** that points at the bot — installs the bot into a personal scope (DMs), team scope (channels), or group chat scope.
3. A **public HTTPS messaging endpoint** for the Bot Framework to reach.
4. **OpenClaw config** with those credentials + DM/group policies.

The Teams app manifest is a zip with `manifest.json`, `outline.png` (32×32), `color.png` (192×192).

---

## 2. Two paths to credentials

The repo documents two ways to obtain the credentials.

### Path A — Teams CLI (recommended)

> *"The `@microsoft/teams.cli` handles bot registration, manifest creation, and credential generation in a single command."*

```bash
npm install -g @microsoft/teams.cli@preview
teams login
teams status   # verify tenant info
```

> *"The Teams CLI is currently in preview. Commands and flags may change between releases."*

### Path B — Azure Portal (manual, no CLI)

From the doc's manual setup section:

1. Ensure the OpenClaw Teams plugin is available (bundled by default).
2. Create an **Azure Bot** in the Portal (App ID + secret + tenant ID).
3. Build a **Teams app package** that references the bot and includes the RSC permissions.
4. Upload/install the Teams app into a team (or personal scope for DMs).
5. Configure `msteams` in `~/.openclaw/openclaw.json` (or env vars) and start the Gateway.
6. The Gateway listens for Bot Framework webhook traffic on `/api/messages` by default.

The detailed Portal steps follow in §5.

---

## 3. Step-by-step (Teams CLI path)

### 3.1 Start a tunnel — Teams cannot reach localhost

Install and authenticate the [devtunnel CLI](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started):

```bash
# One-time setup (persistent URL across sessions)
devtunnel create my-openclaw-bot --allow-anonymous
devtunnel port create my-openclaw-bot -p 3978 --protocol auto

# Each dev session
devtunnel host my-openclaw-bot
# Your endpoint becomes: https://<tunnel-id>.devtunnels.ms/api/messages
```

> *"`--allow-anonymous` is required because Teams cannot authenticate with devtunnels. Each incoming bot request is still validated by the Teams SDK automatically."*

Alternatives the doc mentions: `ngrok http 3978`, `tailscale funnel 3978` — URLs may change each session.

### 3.2 Create the Teams app

```bash
teams app create \
  --name "OpenClaw" \
  --endpoint "https://<your-tunnel-url>/api/messages"
```

This single command (quoted from the doc):
- Creates an Entra ID (Azure AD) application
- Generates a client secret
- Builds and uploads a Teams app manifest (with icons)
- Registers the bot (Teams-managed by default — no Azure subscription needed)

> Output will show `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID`, and a **Teams App ID** — save these.

### 3.3 Configure OpenClaw

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId:       "<CLIENT_ID>",
      appPassword: "<CLIENT_SECRET>",
      tenantId:    "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

Equivalent env vars:
- `MSTEAMS_APP_ID`
- `MSTEAMS_APP_PASSWORD`
- `MSTEAMS_TENANT_ID`

### 3.4 Install the Teams app

`teams app create` prompts you to install — pick "Install in Teams". If you skipped it:

```bash
teams app get <teamsAppId> --install-link
```

### 3.5 Verify

```bash
teams app doctor <teamsAppId>
```

Runs diagnostics across bot registration, AAD app config, manifest validity, and SSO setup.

### 3.6 Start the Gateway

```bash
openclaw gateway
```

The Teams channel starts automatically when the plugin is available and `msteams` config exists with credentials.

### 3.7 If the tunnel URL changes

```bash
teams app update <teamsAppId> --endpoint "https://<new-url>/api/messages"
```

---

## 4. Step-by-step (Azure Portal — fully manual)

This is the doc's manual fallback for environments without the Teams CLI.

### 4.1 Create the Azure Bot

1. Go to [Create Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot).
2. Fill the **Basics** tab:

   | Field | Value |
   |---|---|
   | Bot handle | unique name like `openclaw-msteams` |
   | Subscription | your Azure subscription |
   | Resource group | new or existing |
   | Pricing tier | **Free** for dev/testing |
   | Type of App | **Single Tenant** (recommended) |
   | Creation type | **Create new Microsoft App ID** |

> *"Creation of new multi-tenant bots was deprecated after 2025-07-31. Use **Single Tenant** for new bots."*

3. Click **Review + create → Create** (wait 1–2 minutes).

### 4.2 Get credentials

1. Open the Azure Bot resource → **Configuration**.
2. Copy **Microsoft App ID** → this is your `appId`.
3. Click **Manage Password** → go to the App Registration.
4. Under **Certificates & secrets → New client secret** → copy the **Value** → this is your `appPassword`.
5. Open **Overview** → copy **Directory (tenant) ID** → this is your `tenantId`.

### 4.3 Configure the messaging endpoint

1. Azure Bot → **Configuration**.
2. **Messaging endpoint** = your webhook URL:
   - Production: `https://your-domain.com/api/messages`
   - Local dev: tunnel URL (see §3.1)

### 4.4 Enable the Teams channel

1. Azure Bot → **Channels**.
2. Click **Microsoft Teams** → Configure → Save → accept ToS.

### 4.5 Build the Teams app manifest

The doc gives this minimal valid example (replace IDs and URLs):

```json5
{
  $schema: "https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",
  manifestVersion: "1.23",
  version: "1.0.0",
  id: "00000000-0000-0000-0000-000000000000",
  name: { short: "OpenClaw" },
  developer: {
    name: "Your Org",
    websiteUrl:    "https://example.com",
    privacyUrl:    "https://example.com/privacy",
    termsOfUseUrl: "https://example.com/terms",
  },
  description: { short: "OpenClaw in Teams", full: "OpenClaw in Teams" },
  icons: { outline: "outline.png", color: "color.png" },
  accentColor: "#5B6DEF",
  bots: [
    {
      botId: "11111111-1111-1111-1111-111111111111",   // = Azure Bot App ID
      scopes: ["personal", "team", "groupChat"],
      isNotificationOnly: false,
      supportsCalling: false,
      supportsVideo:  false,
      supportsFiles:  true,                            // required for personal-scope file handling
    },
  ],
  webApplicationInfo: {
    id: "11111111-1111-1111-1111-111111111111",        // = Azure Bot App ID
  },
  authorization: {
    permissions: {
      resourceSpecific: [
        { name: "ChannelMessage.Read.Group",  type: "Application" },
        { name: "ChannelMessage.Send.Group",  type: "Application" },
        { name: "Member.Read.Group",          type: "Application" },
        { name: "Owner.Read.Group",           type: "Application" },
        { name: "ChannelSettings.Read.Group", type: "Application" },
        { name: "TeamMember.Read.Group",      type: "Application" },
        { name: "TeamSettings.Read.Group",    type: "Application" },
        { name: "ChatMessage.Read.Chat",      type: "Application" },
      ],
    },
  },
}
```

Manifest must-have rules from the doc:

- `bots[].botId` **must** equal the Azure Bot App ID.
- `webApplicationInfo.id` **must** equal the Azure Bot App ID.
- `bots[].scopes` must include the surfaces you'll use: `personal`, `team`, `groupChat`.
- `bots[].supportsFiles: true` is required for personal-scope file handling.
- `authorization.permissions.resourceSpecific` must include channel read/send if you want channel traffic.

Build the package:

1. Create icons: `outline.png` (32×32) and `color.png` (192×192).
2. Zip three files together: `manifest.json` + `outline.png` + `color.png`.
3. Upload via Teams Admin Center → Manage apps → Upload, or sideload via Teams → Apps → Manage your apps → Upload a custom app.

### 4.6 Configure OpenClaw and start

Same config as §3.3; then `openclaw gateway`.

---

## 5. RSC permissions — what each one buys you

From the doc's `Current Teams RSC permissions (manifest)` section.

**Team scope (channels):**

| Permission | Effect |
|---|---|
| `ChannelMessage.Read.Group` | Receive all channel messages **without @mention** |
| `ChannelMessage.Send.Group` | Send into channels |
| `Member.Read.Group` | Read team members |
| `Owner.Read.Group` | Read team owners |
| `ChannelSettings.Read.Group` | Read channel settings |
| `TeamMember.Read.Group` | Read team membership |
| `TeamSettings.Read.Group` | Read team settings |

**Group chats:** `ChatMessage.Read.Chat` (Application) — receive all group chat messages without @mention.

Add RSC permissions later via:

```bash
teams app rsc add <teamsAppId> ChannelMessage.Read.Group --type Application
```

### Capabilities matrix from the doc

**With Teams RSC only (no Graph):**
- ✅ Read channel message **text**
- ✅ Send channel message **text**
- ✅ Receive personal (DM) file attachments
- ❌ Channel/group image or file contents (payload is only an HTML stub)
- ❌ Downloading attachments stored in SharePoint/OneDrive
- ❌ Reading message history beyond the live webhook event

**With RSC + Microsoft Graph Application permissions:**
- ✅ Download hosted contents (pasted images)
- ✅ Download file attachments in SharePoint/OneDrive
- ✅ Read channel/chat history via Graph

| Capability | RSC | Graph API |
|---|---|---|
| Real-time messages | Yes (webhook) | No (poll only) |
| Historical messages | No | Yes |
| Setup complexity | Manifest only | Admin consent + token flow |
| Works offline | No | Yes |

For channel attachments / history, add Graph App permissions in Entra ID:
- `ChannelMessage.Read.All` (channel attachments + history)
- `Chat.Read.All` or `ChatMessage.Read.All` (group chats)

Then **grant admin consent**, bump the manifest version, re-upload, reinstall in Teams, and **fully quit and relaunch Teams** to clear cached app metadata.

---

## 6. Access control

### DM access

- Default `channels.msteams.dmPolicy = "pairing"`. Unknown senders are ignored until approved.
- `channels.msteams.allowFrom` should use **stable AAD object IDs** or static access groups like `accessGroup:core-team`.
- > *"Do not rely on UPN/display-name matching for allowlists — they can change. OpenClaw disables direct name matching by default; opt in explicitly with `channels.msteams.dangerouslyAllowNameMatching: true`."*
- The wizard can resolve names to IDs via Microsoft Graph when credentials allow.

### Group access

- Default `channels.msteams.groupPolicy = "allowlist"` (blocked unless `groupAllowFrom` is set).
- `groupAllowFrom` falls back to `allowFrom`.
- `groupPolicy: "open"` allows any member (still mention-gated by default).
- `groupPolicy: "disabled"` blocks all channels.

Example:
```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: [
        "00000000-0000-0000-0000-000000000000",
        "accessGroup:core-team",
      ],
    },
  },
}
```

### Teams + channel allowlist

- Scope replies by listing teams and channels under `channels.msteams.teams`.
- Use stable Teams conversation IDs from Teams links, not display names.
- When `groupPolicy: "allowlist"` and a teams allowlist is present, only listed teams/channels are accepted (mention-gated).

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      teams: {
        "My Team": {
          channels: {
            General: { requireMention: true },
          },
        },
      },
    },
  },
}
```

> *"Unresolved team/channel names are kept as typed but ignored for routing by default unless `channels.msteams.dangerouslyAllowNameMatching: true` is enabled."*

---

## 7. Production auth — federated (certificate or managed identity)

From the doc: *"For production deployments, OpenClaw supports federated authentication as a more secure alternative to client secrets."* Added in v2026.4.11.

### Option A — Certificate

1. Generate or obtain a PEM cert with private key.
2. In Entra ID → App Registration → **Certificates & secrets → Certificates** → upload the public cert.

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId:    "<APP_ID>",
      tenantId: "<TENANT_ID>",
      authType: "federated",
      certificatePath: "/path/to/cert.pem",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

Env: `MSTEAMS_AUTH_TYPE=federated`, `MSTEAMS_CERTIFICATE_PATH=/path/to/cert.pem`.

### Option B — Azure Managed Identity

How it works (from the doc):
1. The bot pod/VM has a managed identity (system or user-assigned).
2. A federated identity credential links it to the Entra ID app registration.
3. At runtime, OpenClaw uses `@azure/identity` to acquire tokens from IMDS (`169.254.169.254`).
4. The token is passed to the Teams SDK.

System-assigned:
```json5
{
  channels: { msteams: {
    enabled: true,
    appId: "<APP_ID>", tenantId: "<TENANT_ID>",
    authType: "federated",
    useManagedIdentity: true,
    webhook: { port: 3978, path: "/api/messages" },
  }}
}
```

User-assigned: add `managedIdentityClientId: "<MI_CLIENT_ID>"`.

Env: `MSTEAMS_AUTH_TYPE=federated`, `MSTEAMS_USE_MANAGED_IDENTITY=true`, `MSTEAMS_MANAGED_IDENTITY_CLIENT_ID=<client-id>` (user-assigned only).

#### AKS Workload Identity (from the doc verbatim)

1. Enable workload identity on AKS.
2. Create a federated identity credential on the Entra ID app:
   ```bash
   az ad app federated-credential create --id <APP_OBJECT_ID> --parameters '{
     "name": "my-bot-workload-identity",
     "issuer": "<AKS_OIDC_ISSUER_URL>",
     "subject": "system:serviceaccount:<NAMESPACE>:<SERVICE_ACCOUNT>",
     "audiences": ["api://AzureADTokenExchange"]
   }'
   ```
3. Annotate the K8s service account: `azure.workload.identity/client-id: "<APP_CLIENT_ID>"`.
4. Label the pod: `azure.workload.identity/use: "true"`.
5. Ensure network access to `169.254.169.254/32:80` (NetworkPolicy egress rule).

### Auth method comparison

| Method | Config | Pros | Cons |
|---|---|---|---|
| Client secret | `appPassword` | Simple | Secret rotation, less secure |
| Certificate | `authType:"federated"` + `certificatePath` | No shared secret over network | Cert management overhead |
| Managed Identity | `authType:"federated"` + `useManagedIdentity` | Passwordless | Azure infrastructure required |

> *"When `authType` is not set, OpenClaw defaults to client secret authentication. Existing configurations continue to work without changes."*

---

## 8. SharePoint for group/channel file sending

| Context | How files are sent | Setup needed |
|---|---|---|
| DMs | FileConsentCard flow | Works out of the box |
| Group chats/channels | Upload to SharePoint + share link | Requires `sharePointSiteId` + Graph |
| Images (any context) | Base64-inline | Works out of the box |

From the doc: *"Bots don't have a personal OneDrive drive. To send files in group chats/channels, the bot uploads to a SharePoint site and creates a sharing link."*

### Setup

1. Add Graph App permissions in Entra ID:
   - `Sites.ReadWrite.All` (Application) — upload files
   - `Chat.Read.All` (Application, optional) — per-user sharing links
2. Grant admin consent.
3. Get the SharePoint site ID:
   ```bash
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"
   # Response includes: "id": "contoso.sharepoint.com,guid1,guid2"
   ```
4. Configure:
   ```json5
   {
     channels: { msteams: {
       sharePointSiteId: "contoso.sharepoint.com,guid1,guid2"
     }}
   }
   ```

Uploaded files land in `/OpenClawShared/` in the configured site's default library.

| Permission | Sharing behavior |
|---|---|
| `Sites.ReadWrite.All` only | Org-wide sharing link |
| `Sites.ReadWrite.All` + `Chat.Read.All` | Per-user (only chat members) |

---

## 9. Reply style — threads vs posts

Teams has two channel UI styles over the same data model:

| Style | Description | Recommended `replyStyle` |
|---|---|---|
| **Posts** (classic) | Cards with threaded replies underneath | `thread` (default) |
| **Threads** (Slack-like) | Linear flow | `top-level` |

> *"The Teams API does not expose which UI style a channel uses."*

Wrong setting symptoms:
- `thread` in a Threads-style channel → replies appear nested awkwardly
- `top-level` in a Posts-style channel → replies appear as separate top-level posts

Fix per-channel:

```json5
{
  channels: { msteams: {
    replyStyle: "thread",
    teams: {
      "19:abc...@thread.tacv2": {
        channels: {
          "19:xyz...@thread.tacv2": { replyStyle: "top-level" }
        }
      }
    }
  }}
}
```

Resolution precedence (first non-`undefined` wins):
1. Per-channel
2. Per-team
3. Global `channels.msteams.replyStyle`
4. Implicit default: `requireMention: true` → `thread`; `requireMention: false` → `top-level`

---

## 10. Full key configuration reference (from the doc's Configuration section)

- `channels.msteams.enabled`
- `channels.msteams.appId`, `appPassword`, `tenantId`
- `channels.msteams.webhook.port` (default `3978`)
- `channels.msteams.webhook.path` (default `/api/messages`)
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (default `pairing`)
- `channels.msteams.allowFrom`: AAD object IDs (preferred)
- `channels.msteams.dangerouslyAllowNameMatching`: break-glass for UPN/display-name matching
- `channels.msteams.textChunkLimit`
- `channels.msteams.chunkMode`: `length` (default) or `newline`
- `channels.msteams.mediaAllowHosts`: inbound attachment host allowlist (default: Microsoft/Teams domains)
- `channels.msteams.mediaAuthAllowHosts`: hosts that get the `Authorization` header on media retries
- `channels.msteams.requireMention` (default `true`)
- `channels.msteams.replyStyle`: `thread | top-level`
- `channels.msteams.teams.<teamId>.replyStyle` / `.requireMention` / `.tools` / `.toolsBySender`
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle` / `.requireMention` / `.tools` / `.toolsBySender`
- `channels.msteams.actions.memberInfo` (default: enabled when Graph creds are available)
- `channels.msteams.authType`: `"secret"` (default) or `"federated"`
- `channels.msteams.certificatePath`, `.certificateThumbprint`
- `channels.msteams.useManagedIdentity`, `.managedIdentityClientId`
- `channels.msteams.sharePointSiteId`
- `channels.msteams.historyLimit` (default 50; `0` disables)
- `channels.msteams.dmHistoryLimit`, `dms.<user_id>.historyLimit`
- `channels.msteams.configWrites` (default: enabled — `/config set|unset` allowed)

Session keys (deterministic, from the doc):
- DM: `agent:<agentId>:<mainKey>`
- Channel: `agent:<agentId>:msteams:channel:<conversationId>`
- Group: `agent:<agentId>:msteams:group:<conversationId>`

---

## 11. Updating an installed Teams app

```bash
teams app manifest download <teamsAppId> manifest.json
# Edit manifest.json locally...
teams app manifest upload manifest.json <teamsAppId>
# Version is auto-bumped if content changed
```

> *"After updating, reinstall the app in each team for new permissions to take effect, and **fully quit and relaunch Teams** (not just close the window) to clear cached app metadata."*

Manual (no CLI) update:
1. Edit `manifest.json` with new settings.
2. **Increment `version`** (e.g. `1.0.0` → `1.1.0`).
3. Re-zip with icons.
4. Upload in Teams Admin Center → Manage apps → find the app → Upload new version, or sideload via Teams → Apps → Manage your apps → Upload a custom app.

---

## 12. Known limitations (from the doc)

### Webhook timeouts
> *"Teams delivers messages via HTTP webhook. If processing takes too long (e.g. slow LLM responses), you may see: Gateway timeouts; Teams retrying the message (causing duplicates); Dropped replies. OpenClaw handles this by returning quickly and sending replies proactively, but very slow responses may still cause issues."*

### Formatting
> *"Teams markdown is more limited than Slack or Discord: Basic formatting works (bold, italic, code, links). Complex markdown (tables, nested lists) may not render correctly. Adaptive Cards are supported for polls and semantic presentation sends."*

### Status of the channel
> *"Status: text + DM attachments are supported; channel/group file sending requires `sharePointSiteId` + Graph permissions. Polls are sent via Adaptive Cards. Message actions expose explicit `upload-file` for file-first sends."*

---

## 13. Verification checklist

```bash
# CLI (if you used Teams CLI)
teams app doctor <teamsAppId>

# OpenClaw side
openclaw gateway status
openclaw channels status --probe
openclaw logs --follow
```

Then DM the bot from Teams. Look for incoming activity in Gateway logs.

---

## 14. Source map

- `docs/channels/msteams.md` — primary source for everything above
- `docs/channels/index.md` — confirms bundled status
- `docs/channels/channel-routing.md` — session-key shapes
- `extensions/msteams/` — bundled plugin implementation
- `docs/gateway/configuration.md` — shared channel patterns
