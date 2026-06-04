// The cli channel plugin — same SDK factory as whatsapp/msteams/webhook. Its
// transport is the gateway WebSocket hub (each connected CLI is a peer).
import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core.js";
import { cliChannelOutbound, cliMessageAdapter } from "./channel-outbound.js";
import { cliTransport } from "./channel.runtime.js";

export const cliPlugin: ChannelPlugin = createChatChannelPlugin({
  id: "cli",
  meta: {
    id: "cli",
    label: "CLI",
    selectionLabel: "CLI (WebSocket)",
    docsPath: "/channels/cli",
    blurb: "Command-line clients connected over the gateway WebSocket.",
  },
  capabilities: {
    chatTypes: ["direct"],
  },
  outbound: cliChannelOutbound,
  message: cliMessageAdapter,
  transport: cliTransport,
});
