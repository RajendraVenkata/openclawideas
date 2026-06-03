// ──────────────────────────────────────────────────────────────────────────
// Real origin: extensions/whatsapp/src/channel.ts
//   export const whatsappPlugin: ChannelPlugin<ResolvedWhatsAppAccount> =
//     createChatChannelPlugin<ResolvedWhatsAppAccount>({ … })
//
// Same name + factory. The real plugin passes ~20 adapters (pairing, security,
// groups, mentions, commands, status, setup, directory, …). We pass the few a
// minimal text channel needs: meta, capabilities, outbound, message, messaging,
// and the (simplified) transport.
// ──────────────────────────────────────────────────────────────────────────

import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core.js";
import { whatsappChannelOutbound, whatsappMessageAdapter } from "./channel-outbound.js";
import { whatsappTransport } from "./channel.runtime.js";

export const whatsappPlugin: ChannelPlugin = createChatChannelPlugin({
  id: "whatsapp",
  meta: {
    id: "whatsapp",
    label: "WhatsApp",
    selectionLabel: "WhatsApp",
    docsPath: "/channels/whatsapp",
    blurb: "Chat with your assistant on WhatsApp.",
    markdownCapable: true,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: true,
    reply: true,
    media: true,
  },
  outbound: whatsappChannelOutbound,
  message: whatsappMessageAdapter,
  messaging: {
    targetPrefixes: ["whatsapp"],
    normalizeTarget: (raw) => raw.replace(/^whatsapp:/, "").trim() || null,
  },
  transport: whatsappTransport,
});
