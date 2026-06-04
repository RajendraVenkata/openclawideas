// ──────────────────────────────────────────────────────────────────────────
// Real origin: extensions/whatsapp/src/channel-outbound.ts.
// Exposes the channel's outbound base (`whatsappChannelOutbound.sendText`) and a
// message adapter (`whatsappMessageAdapter` via `defineChannelMessageAdapter`),
// both delegating to `sendMessageWhatsApp`. Same names as the real plugin; the
// real version adds chunking, receipts, media — trimmed here to text.
// ──────────────────────────────────────────────────────────────────────────

import {
  defineChannelMessageAdapter,
  type ChannelOutboundAdapter,
} from "openclaw/plugin-sdk/channel-core.js";
import { sendMessageWhatsApp } from "./send.js";

export const whatsappChannelOutbound: ChannelOutboundAdapter = {
  sendText: async ({ to, text, replyToId }) => {
    const result = await sendMessageWhatsApp(to, text, {
      replyToId,
      preserveLeadingWhitespace: true,
    });
    return { messageId: result.messageId };
  },
};

export const whatsappMessageAdapter = defineChannelMessageAdapter({
  id: "whatsapp",
  capabilities: { text: true, replyTo: true },
  send: {
    text: async (ctx) => {
      const result = await whatsappChannelOutbound.sendText({
        to: ctx.to,
        text: ctx.text,
        cfg: ctx.cfg,
        replyToId: ctx.replyToId,
      });
      return { messageId: result.messageId };
    },
  },
});
