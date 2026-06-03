// ──────────────────────────────────────────────────────────────────────────
// SIMULATED transport — real origin: extensions/whatsapp/src/channel.runtime.ts
// + connection-controller.ts (which use the Baileys library: makeWASocket, a QR
// pairing flow, end-to-end encryption, reconnects, and a `messages.upsert`
// event). None of that runs offline, so we fake the wire while keeping the same
// connect → onInbound → stop shape the gateway expects.
// ──────────────────────────────────────────────────────────────────────────

import type {
  ChannelConnection,
  ChannelTransport,
} from "openclaw/plugin-sdk/channel-core.js";

export const whatsappTransport: ChannelTransport = {
  async connect({ accountId, onInbound }) {
    console.log(`[whatsapp] connecting (account=${accountId}) — SIMULATED, no Baileys/QR`);
    // REAL:
    //   const sock = makeWASocket({ auth });
    //   sock.ev.on("connection.update", ({ qr }) => qr && printQrToTerminal(qr));
    //   sock.ev.on("messages.upsert", ({ messages }) =>
    //     onInbound(toInbound(messages[0])));   // ← the live inbound event

    const connection: ChannelConnection = {
      async stop() {
        // REAL: await sock.end()
        console.log("[whatsapp] disconnected");
      },
      // SIMULATION ONLY: lets the gateway inject an inbound message over HTTP,
      // standing in for the real `messages.upsert` event above.
      async simulateInbound(from, text) {
        console.log(`📥 [whatsapp ← ${from}] ${text}`);
        await onInbound({ channel: "whatsapp", from, body: text, timestamp: Date.now() });
      },
    };
    return connection;
  },
};
