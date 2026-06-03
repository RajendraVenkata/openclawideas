# MS Teams — going from local mode to a real Azure Bot

The MS Teams **read** path in this demo (`extensions/msteams/src/monitor.ts`) is real:
it hosts the Bot Framework messaging endpoint at `POST /api/messages` on port **3978**.

- **Local/emulator mode (default here):** no `appPassword` set → JWT validation is OFF.
  The placeholder `appId`/`tenantId` in `openclaw.json` are enough; you POST sample
  Activities yourself (see README). **No Azure needed.**
- **Real mode:** set real credentials from an **Azure Bot** + expose the endpoint over
  HTTPS + sideload a Teams app. Then live Teams messages hit `/api/messages`.

This file covers creating the **Azure Bot in the Azure Portal** and plugging the values
into this demo. (Steps mirror `../openclaw-msteams-manual-setup.md` §4, which is grounded
in `openclaw/docs/channels/msteams.md`.)

---

## What you're getting from Azure

Three credentials, all from **Azure / Microsoft Entra ID** — *not* from the Teams client:

| Demo config key | Env var | Azure source |
|---|---|---|
| `channels.msteams.appId` | `MSTEAMS_APP_ID` | Azure Bot → **Microsoft App ID** |
| `channels.msteams.appPassword` | `MSTEAMS_APP_PASSWORD` | App Registration → **client secret value** |
| `channels.msteams.tenantId` | `MSTEAMS_TENANT_ID` | Entra ID → **Directory (tenant) ID** |

---

## Step 0 — Expose `/api/messages` over HTTPS (Teams can't reach localhost)

The Bot Framework calls your endpoint *from the cloud*, so port 3978 must be public over
HTTPS. Use a tunnel (any one):

```bash
# Azure Dev Tunnels (recommended)
devtunnel create my-openclaw-bot --allow-anonymous
devtunnel port create my-openclaw-bot -p 3978 --protocol auto
devtunnel host my-openclaw-bot
# → endpoint: https://<tunnel-id>.devtunnels.ms/api/messages

# Alternatives
ngrok http 3978
tailscale funnel 3978
```

`--allow-anonymous` is required (Teams can't authenticate to the tunnel; the Teams SDK
still validates each request). Note the resulting `https://…/api/messages` URL.

---

## Step 1 — Create the Azure Bot

1. Open **[Create Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot)**.
2. Fill the **Basics** tab:

   | Field | Value |
   |---|---|
   | Bot handle | a unique name, e.g. `openclaw-msteams` |
   | Subscription | your Azure subscription |
   | Resource group | new or existing |
   | Pricing tier | **Free** (fine for dev/testing) |
   | Type of App | **Single Tenant** (recommended) |
   | Creation type | **Create new Microsoft App ID** |

   > Multi-tenant bot creation was deprecated after 2025-07-31 — use **Single Tenant** for new bots.

3. **Review + create → Create** (wait 1–2 minutes for deployment).

## Step 2 — Get the credentials

1. Open the Azure Bot resource → **Configuration**.
2. Copy **Microsoft App ID** → this is your **`appId`**.
3. Click **Manage Password** (opens the linked App Registration).
4. **Certificates & secrets → New client secret → Add**, then copy the secret **Value**
   (not the Secret ID) → this is your **`appPassword`**. *Copy it now; it's shown once.*
5. Back on the App Registration **Overview**, copy **Directory (tenant) ID** → **`tenantId`**.

## Step 3 — Set the messaging endpoint

1. Azure Bot → **Configuration**.
2. **Messaging endpoint** = your tunnel URL + `/api/messages`, e.g.
   `https://<tunnel-id>.devtunnels.ms/api/messages`.
3. **Apply**.

## Step 4 — Enable the Teams channel

1. Azure Bot → **Channels**.
2. Click **Microsoft Teams** → **Configure** → **Apply/Save** → accept the Terms of Service.

## Step 5 — Sideload a Teams app (so you can chat with the bot)

You need a small Teams app package whose bot id points at your Azure Bot:

1. Create `manifest.json` with `bots[].botId` **and** `webApplicationInfo.id` **both equal
   to the Azure Bot App ID** (`appId`), and `scopes` including `personal` / `team` /
   `groupChat`. (Full minimal manifest + required RSC permissions are in
   `../openclaw-msteams-manual-setup.md` §4.5.)
2. Add icons `outline.png` (32×32) and `color.png` (192×192).
3. **Zip** `manifest.json` + `outline.png` + `color.png`.
4. In Teams: **Apps → Manage your apps → Upload a custom app** (or Teams Admin Center →
   Manage apps → Upload). Add the bot to a chat / team.

---

## Step 6 — Point this demo at the real bot

Put the three values into `openclaw.json` (or env vars). **Setting `appPassword` is what
flips the webhook out of local mode — JWT validation turns ON.**

```json
"channels": {
  "msteams": {
    "enabled": true,
    "accountId": "default",
    "appId":       "<MICROSOFT_APP_ID>",
    "appPassword": "<CLIENT_SECRET_VALUE>",
    "tenantId":    "<DIRECTORY_TENANT_ID>",
    "webhook": { "port": 3978, "path": "/api/messages" }
  }
}
```

Or via environment (read by `extensions/msteams/src/token.ts`):

```bash
export MSTEAMS_APP_ID=<MICROSOFT_APP_ID>
export MSTEAMS_APP_PASSWORD=<CLIENT_SECRET_VALUE>
export MSTEAMS_TENANT_ID=<DIRECTORY_TENANT_ID>
```

Then run the demo and keep the tunnel pointed at port 3978:

```bash
npm start
# [msteams] webhook listening on http://127.0.0.1:3978/api/messages
# (no "JWT validation DISABLED" line now — real validation is on)
```

Message the bot in Teams; the activity arrives at your tunnel → `/api/messages` → the
`monitorMSTeamsProvider` read path → the agent.

---

## Important caveat for this demo

This bare-gateway-loop reproduces the **read path with real names/structure**, but two
pieces are still simulated and would need finishing for a fully-working live bot:

1. **Inbound JWT verification** — `createBotFrameworkJwtValidator` (in `sdk.ts`) returns
   "ok" without cryptographically verifying the token. Real verification checks the JWT
   signature + issuer + `audience === appId` against the Bot Framework OpenID metadata.
2. **Outbound delivery** — `sendMessageMSTeams` (in `send.ts`) prints instead of calling
   `adapter.continueConversation(ref)` with the stored conversation reference. So the bot
   *receives* live messages but won't *reply back into Teams* until outbound is wired to
   the `@microsoft/teams.apps` adapter.

Both are localized swaps inside `sdk.ts` / `send.ts`; the rest of the structure
(`monitorMSTeamsProvider`, the handler, the conversation store) stays as-is.

For the complete, production setup (Teams CLI path, manifest, RSC permissions, SSO,
diagnostics), follow `../openclaw-msteams-manual-setup.md`.
