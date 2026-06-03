// ──────────────────────────────────────────────────────────────────────────
// Channel plugin SDK — FAITHFUL SUBSET.
// Real origins (the contract is split across several files in openclaw):
//   • src/channels/plugins/channel-id.types.ts   → ChannelId
//   • src/channels/plugins/types.core.ts          → ChannelMeta, ChannelCapabilities
//   • src/channels/plugins/types.adapters.ts      → the adapter shapes
//   • src/channels/plugins/types.plugin.ts        → ChannelPlugin
//   • src/plugin-sdk/channel-core.ts              → createChatChannelPlugin
//   • src/plugin-sdk/channel-message.ts           → defineChannelMessageAdapter
//
// The real ChannelPlugin has ~40 optional adapter slots (pairing, security,
// groups, status, setup, directory, streaming, …). We keep only the few a
// minimal message channel actually uses, with the REAL names and call shapes,
// and consolidate them into this one file. Each omission is noted.
// ──────────────────────────────────────────────────────────────────────────

import type { OpenClawConfig } from "../config/types.openclaw.js";

// ── Identity (src/channels/plugins/channel-id.types.ts) ─────────────────────
// `(string & {})` keeps autocomplete for the known ids while still allowing any
// string — this is the real trick from the codebase.
export type ChannelId = "whatsapp" | "telegram" | "slack" | "discord" | "msteams" | (string & {});
export type ChatType = "direct" | "group" | "channel";

// ── ChannelMeta (verbatim-trimmed from src/channels/plugins/types.core.ts) ──
export type ChannelMeta = {
  id: ChannelId;
  label: string;
  selectionLabel: string;
  docsPath: string;
  blurb: string;
  markdownCapable?: boolean;
  // real also has: order, aliases, exposure, systemImage, showInSetup, … (omitted)
};

// ── ChannelCapabilities (trimmed from src/channels/plugins/types.core.ts) ───
export type ChannelCapabilities = {
  chatTypes: Array<ChatType | "thread">;
  reactions?: boolean;
  reply?: boolean;
  media?: boolean;
  // real also has: polls, edit, unsend, threads, tts, nativeCommands, … (omitted)
};

// ── Outbound + message adapters (src/plugin-sdk/channel-message.ts) ─────────
// The leaf delivery shape the channel's outbound base exposes.
export type ChannelOutboundAdapter = {
  sendText: (params: { to: string; text: string; replyToId?: string | null }) => Promise<{
    messageId: string;
  }>;
};

export type ChannelMessageSendContext = {
  to: string;
  text: string;
  replyToId?: string | null;
};

export type ChannelMessageSendResult = {
  messageId: string;
};

export type ChannelMessageAdapter = {
  id: ChannelId;
  // real shape: durableFinal.capabilities — flattened here.
  capabilities: { text: boolean; replyTo?: boolean };
  send: {
    text: (ctx: ChannelMessageSendContext) => Promise<ChannelMessageSendResult>;
  };
};

// Identity helper — real `defineChannelMessageAdapter` validates + brands the
// adapter; here it just returns it (with full type-checking of the shape).
export function defineChannelMessageAdapter(adapter: ChannelMessageAdapter): ChannelMessageAdapter {
  return adapter;
}

// Build a message adapter straight from an outbound adapter (real origin:
// src/plugin-sdk/channel-message.ts → createChannelMessageAdapterFromOutbound).
// MS Teams uses this instead of hand-writing `send.text`; the adapter just
// forwards to `outbound.sendText`.
export function createChannelMessageAdapterFromOutbound(params: {
  id: ChannelId;
  outbound: ChannelOutboundAdapter;
  capabilities?: { text: boolean; replyTo?: boolean };
}): ChannelMessageAdapter {
  return {
    id: params.id,
    capabilities: params.capabilities ?? { text: true, replyTo: true },
    send: {
      text: async (ctx) => {
        const result = await params.outbound.sendText({
          to: ctx.to,
          text: ctx.text,
          replyToId: ctx.replyToId,
        });
        return { messageId: result.messageId };
      },
    },
  };
}

// ── Messaging adapter (target parsing) ──────────────────────────────────────
export type ChannelMessagingAdapter = {
  targetPrefixes: string[];
  normalizeTarget?: (raw: string) => string | null;
};

// ── Transport seam — SIMPLIFIED stand-in ────────────────────────────────────
// Real openclaw connects the wire in a per-channel runtime / connection
// controller (extensions/whatsapp/src/channel.runtime.ts + connection-controller.ts),
// driven by the gateway channel manager — NOT a field on the plugin. We model it
// as one small adapter so the bare loop can start a channel generically.
export type ChannelInbound = {
  channel: ChannelId;
  from: string;
  body: string;
  timestamp: number;
};
export type InboundHandler = (msg: ChannelInbound) => Promise<void>;
export type ChannelConnection = {
  stop(): Promise<void>;
  // SIMULATION ONLY — inject a fake inbound (stands in for the live transport's
  // message event, e.g. Baileys' `messages.upsert`).
  simulateInbound(from: string, text: string): Promise<void>;
};
export type ChannelTransport = {
  connect(params: { accountId: string; onInbound: InboundHandler }): Promise<ChannelConnection>;
};

// ── ChannelPlugin (faithful subset of src/channels/plugins/types.plugin.ts) ─
export type ChannelPlugin = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  outbound?: ChannelOutboundAdapter;
  message?: ChannelMessageAdapter;
  messaging?: ChannelMessagingAdapter;
  transport?: ChannelTransport; // simplified seam (see above)
  // real ChannelPlugin also has: pairing, security, groups, mentions, status,
  // setup, commands, directory, streaming, threading, allowlist, doctor, … (omitted)
};

// ── Factory (src/plugin-sdk/channel-core.ts → createChatChannelPlugin) ──────
// The real factory takes a nested `{ outbound, threading, pairing, base: {…} }`
// shape and merges chat-channel defaults. We keep a flatter input but the same
// name + intent: assemble a normalized ChannelPlugin.
export function createChatChannelPlugin(input: ChannelPlugin): ChannelPlugin {
  return input;
}

// Re-exported so plugins can `import type { OpenClawConfig }` shape if needed.
export type { OpenClawConfig };
