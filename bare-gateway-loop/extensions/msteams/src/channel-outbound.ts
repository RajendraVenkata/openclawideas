// ──────────────────────────────────────────────────────────────────────────
// Real origin: extensions/msteams/src/channel.ts (lines ~414, ~439).
// MS Teams builds its message adapter with `createChannelMessageAdapterFromOutbound`
// — different from WhatsApp, which hand-writes `defineChannelMessageAdapter`. Both
// end up delegating to the channel's leaf send (`sendMessageMSTeams`).
// ──────────────────────────────────────────────────────────────────────────

import {
  createChannelMessageAdapterFromOutbound,
  type ChannelOutboundAdapter,
} from "openclaw/plugin-sdk/channel-core.js";
import { sendMessageMSTeams } from "./send.js";

export const msteamsChannelOutbound: ChannelOutboundAdapter = {
  sendText: async ({ to, text, replyToId }) => {
    const result = await sendMessageMSTeams({ to, text, replyToId });
    return { messageId: result.messageId };
  },
};

export const msteamsMessageAdapter = createChannelMessageAdapterFromOutbound({
  id: "msteams",
  outbound: msteamsChannelOutbound,
});
