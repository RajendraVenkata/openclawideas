# Custom Webhook Channel (standalone)

A self-contained custom OpenClaw-style channel: **inbound** over an HTTP webhook,
**outbound** delivered asynchronously to a callback URL. It carries its own minimal
`ChannelPlugin` SDK (same faithful pattern as `../bare-gateway-loop`) so it depends on
**nothing else** and runs on its own.

```
POST /webhook/inbound { from, text }
  → verify X-Webhook-Secret
  → 202 Accepted                 (ack immediately — async, like a real chat webhook)
  → onInbound → runAgent(text) → reply
       → POST outbound.url { to, text }      (or print, if no url configured)
```

## Run it

```bash
cd openclawideas/custom-webhook-channel
npm install        # one dependency: tsx
npm start
```

You'll see:
```
[gateway] channel registered: webhook (Custom Webhook)
[webhook] inbound listening on http://127.0.0.1:4000/webhook/inbound (X-Webhook-Secret required)
[gateway] channels started: webhook
```

## Send it a message (another terminal)

```bash
curl -s -i -H "X-Webhook-Secret: dev-secret" -H "content-type: application/json" \
  -d '{"from":"alice","text":"hello there"}' \
  http://127.0.0.1:4000/webhook/inbound
# → HTTP 202 {"ok":true,"accepted":true}
```

Gateway console shows ingress → agent → outbound:
```
📥 [webhook ← alice] hello there
📤 [webhook → alice] 🤖 (echo agent) you said: "hello there" — 11 chars  (no outbound.url set — printed)
```

- Wrong/missing `X-Webhook-Secret` → **401** (omit `inbound.secret` in config for no check).
- Empty `text` → agent returns nothing, no outbound.

## See the real async outbound round-trip

By default the reply is **printed** (so it runs offline). To watch it actually POST out:

1. In `openclaw.json`, uncomment the `outbound` block:
   ```json
   "outbound": { "url": "http://127.0.0.1:4001/receive" }
   ```
2. Start the tiny receiver in one terminal: `npm run receiver`
3. `npm start` in another, then POST a message.

The receiver logs what it got:
```
📨 outbound received: {"to":"alice","text":"🤖 (echo agent) you said: \"hello there\" — 11 chars"}
```

## Config (`openclaw.json`)

```jsonc
"channels": {
  "webhook": {
    "enabled": true,
    "inbound":  { "port": 4000, "path": "/webhook/inbound", "secret": "dev-secret" },
    "outbound": { "url": "http://127.0.0.1:4001/receive" }   // optional; omit → print
  }
}
```

## Layout

```
src/
  config-types.ts      OpenClawConfig / ChannelsConfig / WebhookChannelConfig
  channel-sdk.ts       minimal ChannelPlugin contract + factory + catalog (self-contained)
  channel-manager.ts   loads enabled plugins, wires inbound → agent → outbound
  agent-stub.ts        echo agent (swap for a real agent later)
  bootstrap.ts         the runner (load config → start channels → wait)
extensions/webhook/src/
  channel.ts           webhookPlugin = createChannelPlugin({...})
  channel-outbound.ts  webhookChannelOutbound + webhookMessageAdapter
  send.ts              sendMessageWebhook({to,text,cfg}) → POST outbound.url (or print)
  monitor.ts           the inbound webhook server (POST /webhook/inbound)
  channel.runtime.ts   webhookTransport (connect → start monitor → onInbound)
  register.ts          registers the plugin into the catalog
receiver.mjs           tiny outbound receiver for testing the async POST
```

## How to extend it

- **Make the agent real:** replace `runAgent` in `src/agent-stub.ts`.
- **Add auth/signatures:** the inbound secret check lives in `extensions/webhook/src/monitor.ts`.
- **Change the wire format:** inbound parsing is in `monitor.ts`; outbound payload in `send.ts`.
- **Add another channel:** create `extensions/<id>/...`, register it, add `channels.<id>` to config — the manager/catalog need no changes (that's the point of the `ChannelPlugin` contract).
