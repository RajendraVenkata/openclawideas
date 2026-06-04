// The plugin — assembled with the loop's SDK factory (createChatChannelPlugin),
// exactly like whatsappPlugin / msteamsPlugin. Registering it makes the webhook
// a first-class channel of the bare gateway loop.
import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core.js";
import { webhookChannelOutbound, webhookMessageAdapter } from "./channel-outbound.js";
import { webhookTransport } from "./channel.runtime.js";

export const webhookPlugin: ChannelPlugin = createChatChannelPlugin({
  id: "webhook",
  meta: {
    id: "webhook",
    label: "Custom Webhook",
    selectionLabel: "Custom Webhook",
    docsPath: "/channels/webhook",
    blurb: "Inbound via HTTP POST; outbound via async callback URL.",
  },
  capabilities: {
    chatTypes: ["direct"],
  },
  outbound: webhookChannelOutbound,
  message: webhookMessageAdapter,
  transport: webhookTransport,
});
