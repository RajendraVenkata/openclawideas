// The transport: on connect, start the inbound webhook and route messages to
// the gateway's onInbound. stop() tears the webhook down.

import type { ChannelConnection, ChannelTransport } from "openclaw/channel-sdk.js";
import { monitorWebhookProvider } from "./monitor.js";

export const webhookTransport: ChannelTransport = {
  async connect({ accountId, cfg, onInbound }) {
    console.log(`[webhook] connecting (account=${accountId})`);
    const { shutdown } = await monitorWebhookProvider({ cfg, onInbound });
    const connection: ChannelConnection = {
      async stop() {
        await shutdown();
      },
    };
    return connection;
  },
};
