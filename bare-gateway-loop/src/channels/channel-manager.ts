// ──────────────────────────────────────────────────────────────────────────
// Channel manager — the gateway side that starts channels and wires inbound.
// Real origin: the gateway channel subsystem (src/channels/* monitors +
// src/gateway/* channel start), which connects each enabled plugin's transport
// and routes inbound messages into the agent.
//
// Flow per enabled plugin:
//   plugin.transport.connect({ onInbound })  →  a live ChannelConnection
//   inbound message  →  resolveInboundRoute → run agent → plugin.message.send.text
// ──────────────────────────────────────────────────────────────────────────

import type { ChannelConnection, ChannelId, ChannelPlugin } from "../plugin-sdk/channel-core.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getEnabledChannelPlugins } from "./plugins/catalog.js";
import { resolveInboundRoute, formatInboundEnvelope } from "../plugin-sdk/inbound-envelope.js";

export type ChannelManagerDeps = {
  // The agent: given the envelope text, produce a reply (or null).
  runAgent: (envelopeText: string) => Promise<string | null>;
};

export type StartedChannel = {
  id: ChannelId;
  connection: ChannelConnection;
};

// Deliver an outbound reply through the plugin's message adapter (real path:
// message.send.text → outbound.sendText → sendMessageWhatsApp → transport).
async function deliverReply(plugin: ChannelPlugin, to: string, text: string): Promise<void> {
  if (plugin.message) {
    await plugin.message.send.text({ to, text });
    return;
  }
  if (plugin.outbound) {
    await plugin.outbound.sendText({ to, text });
  }
}

async function startChannel(
  plugin: ChannelPlugin,
  cfg: OpenClawConfig,
  deps: ChannelManagerDeps,
): Promise<StartedChannel | null> {
  if (!plugin.transport) {
    console.warn(`[channels] ${plugin.id}: no transport — cannot start`);
    return null;
  }

  const connection = await plugin.transport.connect({
    accountId: "default",
    cfg,
    onInbound: async (msg) => {
      // (1) route: channel/peer → agentId + sessionKey
      const route = resolveInboundRoute({
        cfg,
        channel: msg.channel,
        accountId: "default",
        peer: { kind: "direct", id: msg.from },
      });
      // (2) format the agent-facing envelope
      const envelopeText = formatInboundEnvelope(msg);
      console.log(`[channels] routed → ${route.sessionKey}`);
      // (3) run the agent
      const reply = await deps.runAgent(envelopeText);
      // (4) deliver the reply back out the same channel
      if (reply) {
        await deliverReply(plugin, msg.from, reply);
      }
    },
  });

  return { id: plugin.id, connection };
}

// Load enabled plugins from the catalog and start each one.
export async function startChannels(
  cfg: OpenClawConfig,
  deps: ChannelManagerDeps,
): Promise<StartedChannel[]> {
  const plugins = getEnabledChannelPlugins(cfg);
  const started: StartedChannel[] = [];
  for (const plugin of plugins) {
    console.log(`[gateway] channel registered: ${plugin.id} (${plugin.meta.label})`);
    const channel = await startChannel(plugin, cfg, deps);
    if (channel) {
      started.push(channel);
    }
  }
  return started;
}

export async function stopChannels(started: StartedChannel[]): Promise<void> {
  for (const channel of started) {
    await channel.connection.stop();
  }
}
