import {
  createChannelMessageAdapterFromOutbound,
  type ChannelOutboundAdapter,
} from "openclaw/channel-sdk.js";
import { sendMessageWebhook } from "./send.js";

export const webhookChannelOutbound: ChannelOutboundAdapter = {
  sendText: async ({ to, text, cfg }) => sendMessageWebhook({ to, text, cfg }),
};

export const webhookMessageAdapter = createChannelMessageAdapterFromOutbound({
  id: "webhook",
  outbound: webhookChannelOutbound,
});
