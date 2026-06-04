// ──────────────────────────────────────────────────────────────────────────
// Minimal, self-contained channel SDK — the same faithful pattern as the
// OpenClaw bare-gateway-loop (ChannelPlugin + adapters + a catalog), trimmed to
// what a single webhook channel needs. This file has no external dependencies.
// ──────────────────────────────────────────────────────────────────────────

import type { ChannelsConfig, OpenClawConfig } from "./config-types.js";

// Open union: known ids autocomplete, any string still allowed.
export type ChannelId = "webhook" | (string & {});

export type ChannelMeta = { id: ChannelId; label: string; blurb: string };
export type ChannelCapabilities = { chatTypes: Array<"direct" | "group" | "channel"> };

// ── Inbound ────────────────────────────────────────────────────────────────
export type ChannelInbound = {
  channel: ChannelId;
  from: string;
  body: string;
  timestamp: number;
};
export type InboundHandler = (msg: ChannelInbound) => Promise<void>;

// ── Transport (connect → receive inbound → stop) ────────────────────────────
export type ChannelConnection = { stop(): Promise<void> };
export type ChannelTransport = {
  connect(params: {
    accountId: string;
    cfg: OpenClawConfig;
    onInbound: InboundHandler;
  }): Promise<ChannelConnection>;
};

// ── Outbound + message adapters ─────────────────────────────────────────────
export type ChannelOutboundAdapter = {
  sendText: (params: {
    to: string;
    text: string;
    cfg: OpenClawConfig;
    replyToId?: string | null;
  }) => Promise<{ messageId: string }>;
};

export type ChannelMessageSendContext = {
  to: string;
  text: string;
  cfg: OpenClawConfig;
  replyToId?: string | null;
};
export type ChannelMessageSendResult = { messageId: string };
export type ChannelMessageAdapter = {
  id: ChannelId;
  capabilities: { text: boolean };
  send: { text: (ctx: ChannelMessageSendContext) => Promise<ChannelMessageSendResult> };
};

export function defineChannelMessageAdapter(adapter: ChannelMessageAdapter): ChannelMessageAdapter {
  return adapter;
}

export function createChannelMessageAdapterFromOutbound(params: {
  id: ChannelId;
  outbound: ChannelOutboundAdapter;
}): ChannelMessageAdapter {
  return {
    id: params.id,
    capabilities: { text: true },
    send: {
      text: async (ctx) =>
        params.outbound.sendText({
          to: ctx.to,
          text: ctx.text,
          cfg: ctx.cfg,
          replyToId: ctx.replyToId,
        }),
    },
  };
}

// ── Plugin + factory ────────────────────────────────────────────────────────
export type ChannelPlugin = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  outbound?: ChannelOutboundAdapter;
  message?: ChannelMessageAdapter;
  transport?: ChannelTransport;
};

export function createChannelPlugin(plugin: ChannelPlugin): ChannelPlugin {
  return plugin;
}

// ── Catalog (plugins register themselves at import time) ─────────────────────
const registry = new Map<ChannelId, ChannelPlugin>();

export function registerChannelPlugin(plugin: ChannelPlugin): void {
  registry.set(plugin.id, plugin);
}

export function getEnabledChannelPlugins(cfg: OpenClawConfig): ChannelPlugin[] {
  const channels: ChannelsConfig = cfg.channels ?? {};
  const enabled: ChannelPlugin[] = [];
  for (const plugin of registry.values()) {
    const channelCfg = channels[plugin.id as keyof ChannelsConfig];
    if (channelCfg?.enabled) {
      enabled.push(plugin);
    }
  }
  return enabled;
}
