// ──────────────────────────────────────────────────────────────────────────
// MS Teams transport — the "read" path is REAL (faithful), the outbound is still
// simulated. On connect it calls the faithful `monitorMSTeamsProvider`, which
// stands up the Bot Framework messaging endpoint (POST /api/messages, port 3978)
// and routes inbound Activities to `onInbound`.
//
// Real origin: extensions/msteams/src/channel.runtime.ts + monitor.ts. The real
// transport validates JWTs and uses the @microsoft/teams SDK adapter; this runs
// in local/emulator mode (no Azure) so you can POST a sample Activity to test it.
// ──────────────────────────────────────────────────────────────────────────

import type { ChannelConnection, ChannelTransport } from "openclaw/plugin-sdk/channel-core.js";
import { monitorMSTeamsProvider } from "./monitor.js";

export const msteamsTransport: ChannelTransport = {
  async connect({ accountId, cfg, onInbound }) {
    console.log(`[msteams] connecting (account=${accountId}) — Bot Framework webhook`);

    // Start the real inbound webhook (READ path).
    const { shutdown } = await monitorMSTeamsProvider({ cfg, onInbound });

    const connection: ChannelConnection = {
      async stop() {
        await shutdown();
      },
      // Convenience for quick testing without crafting a full Activity: inject
      // straight into onInbound (bypasses the webhook + auth gate).
      async simulateInbound(from, text) {
        console.log(`📥 [msteams ← ${from}] ${text} (direct inject)`);
        await onInbound({ channel: "msteams", from, body: text, timestamp: Date.now() });
      },
    };
    return connection;
  },
};
