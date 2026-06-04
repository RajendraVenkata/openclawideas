// Transport for the cli channel: its "wire" is the gateway WebSocket hub. On
// connect it registers the inbound handler (so a client's `cli.send` becomes an
// inbound message); outbound replies are pushed back via the hub (see send.ts).
import type { ChannelConnection, ChannelTransport } from "openclaw/plugin-sdk/channel-core.js";
import { setCliInbound } from "openclaw/gateway/ws-hub.js";

export const cliTransport: ChannelTransport = {
  async connect({ accountId, onInbound }) {
    console.log(`[cli] connecting (account=${accountId}) — transport = gateway WebSocket`);
    setCliInbound(async (name, text) => {
      await onInbound({ channel: "cli", from: name, body: text, timestamp: Date.now() });
    });
    const connection: ChannelConnection = {
      async stop() {
        setCliInbound(async () => {});
      },
      async simulateInbound(from, text) {
        console.log(`📥 [cli ← ${from}] ${text} (direct inject)`);
        await onInbound({ channel: "cli", from, body: text, timestamp: Date.now() });
      },
    };
    return connection;
  },
};
