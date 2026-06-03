// ──────────────────────────────────────────────────────────────────────────
// Real origin: extensions/msteams/src/channel.ts
//   export const msteamsPlugin: ChannelPlugin<ResolvedMSTeamsAccount, ProbeMSTeamsResult> =
//     createChatChannelPlugin({ … })
//
// Same name + factory as WhatsApp; the differences are real ones: the meta label,
// capabilities (Teams has "channel"/"thread" rather than "group"), and the message
// adapter built via createChannelMessageAdapterFromOutbound.
// ──────────────────────────────────────────────────────────────────────────

import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core.js";
import { msteamsChannelOutbound, msteamsMessageAdapter } from "./channel-outbound.js";
import { msteamsTransport } from "./channel.runtime.js";

export const msteamsPlugin: ChannelPlugin = createChatChannelPlugin({
  id: "msteams",
  meta: {
    id: "msteams",
    label: "Microsoft Teams",
    selectionLabel: "Microsoft Teams (Bot Framework)",
    docsPath: "/channels/msteams",
    blurb: "Teams SDK; enterprise support.",
    markdownCapable: true,
  },
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    reactions: true,
    reply: true,
    media: true,
  },
  outbound: msteamsChannelOutbound,
  message: msteamsMessageAdapter,
  transport: msteamsTransport,
});
