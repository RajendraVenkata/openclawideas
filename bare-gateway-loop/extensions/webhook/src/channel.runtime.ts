// Transport: on connect, start the inbound webhook and route messages to the
// loop's onInbound. stop() tears it down. simulateInbound lets the gateway's
// /channels/webhook/inbound test route inject directly (bypasses the webhook).
import type { ChannelConnection, ChannelTransport } from "openclaw/plugin-sdk/channel-core.js";
import { monitorWebhookProvider } from "./monitor.js";

export const webhookTransport: ChannelTransport = {
  async connect({ accountId, cfg, onInbound }) {
    console.log(`[webhook] connecting (account=${accountId})`);
    const { shutdown } = await monitorWebhookProvider({ cfg, onInbound });
    const connection: ChannelConnection = {
      async stop() {
        await shutdown();
      },
      async simulateInbound(from, text) {
        console.log(`📥 [webhook ← ${from}] ${text} (direct inject)`);
        await onInbound({ channel: "webhook", from, body: text, timestamp: Date.now() });
      },
    };
    return connection;
  },
};
