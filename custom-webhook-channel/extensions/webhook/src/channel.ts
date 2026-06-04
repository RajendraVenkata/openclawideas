// The plugin definition — assembles the adapters via the SDK factory.

import { createChannelPlugin, type ChannelPlugin } from "openclaw/channel-sdk.js";
import { webhookChannelOutbound, webhookMessageAdapter } from "./channel-outbound.js";
import { webhookTransport } from "./channel.runtime.js";

export const webhookPlugin: ChannelPlugin = createChannelPlugin({
  id: "webhook",
  meta: {
    id: "webhook",
    label: "Custom Webhook",
    blurb: "Inbound via HTTP POST; outbound via async callback URL.",
  },
  capabilities: {
    chatTypes: ["direct"],
  },
  outbound: webhookChannelOutbound,
  message: webhookMessageAdapter,
  transport: webhookTransport,
});
