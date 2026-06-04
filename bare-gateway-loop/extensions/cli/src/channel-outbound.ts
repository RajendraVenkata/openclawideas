import {
  createChannelMessageAdapterFromOutbound,
  type ChannelOutboundAdapter,
} from "openclaw/plugin-sdk/channel-core.js";
import { sendMessageCli } from "./send.js";

export const cliChannelOutbound: ChannelOutboundAdapter = {
  sendText: async ({ to, text }) => sendMessageCli({ to, text }),
};

export const cliMessageAdapter = createChannelMessageAdapterFromOutbound({
  id: "cli",
  outbound: cliChannelOutbound,
});
