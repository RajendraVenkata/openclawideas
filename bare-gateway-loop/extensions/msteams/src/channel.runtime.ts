// ──────────────────────────────────────────────────────────────────────────
// SIMULATED transport — real origin: extensions/msteams/src/channel.runtime.ts,
// which uses the **Bot Framework / Azure Bot Service**: a CloudAdapter created
// from the app credentials, inbound `Activity` objects arriving via an HTTP
// `POST /api/messages` endpoint, and stored conversation references for proactive
// replies. None of that runs offline, so we fake the wire while keeping the same
// connect → onInbound → stop shape.
// ──────────────────────────────────────────────────────────────────────────

import type { ChannelConnection, ChannelTransport } from "openclaw/plugin-sdk/channel-core.js";

export const msteamsTransport: ChannelTransport = {
  async connect({ accountId, onInbound }) {
    console.log(`[msteams] connecting (account=${accountId}) — SIMULATED, no Bot Framework`);
    // REAL:
    //   const adapter = new CloudAdapter(botFrameworkAuth);
    //   httpServer.post("/api/messages", (req, res) =>
    //     adapter.process(req, res, (ctx) => onInbound(toInbound(ctx.activity))));
    const connection: ChannelConnection = {
      async stop() {
        console.log("[msteams] disconnected");
      },
      async simulateInbound(from, text) {
        console.log(`📥 [msteams ← ${from}] ${text}`);
        await onInbound({ channel: "msteams", from, body: text, timestamp: Date.now() });
      },
    };
    return connection;
  },
};
