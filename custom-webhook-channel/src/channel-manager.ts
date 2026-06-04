// ──────────────────────────────────────────────────────────────────────────
// The gateway side: load enabled channel plugins, connect their transports, and
// wire inbound → agent → outbound.
//   transport.connect({ onInbound })  →  a live ChannelConnection
//   inbound  →  runAgent  →  message.send.text → outbound.sendText
// ──────────────────────────────────────────────────────────────────────────

import type { ChannelConnection, ChannelId, ChannelPlugin } from "./channel-sdk.js";
import { getEnabledChannelPlugins } from "./channel-sdk.js";
import type { OpenClawConfig } from "./config-types.js";

export type ChannelManagerDeps = {
  runAgent: (text: string) => Promise<string | null>;
};

export type StartedChannel = {
  id: ChannelId;
  connection: ChannelConnection;
};

async function deliverReply(
  plugin: ChannelPlugin,
  cfg: OpenClawConfig,
  to: string,
  text: string,
): Promise<void> {
  if (plugin.message) {
    await plugin.message.send.text({ to, text, cfg });
    return;
  }
  if (plugin.outbound) {
    await plugin.outbound.sendText({ to, text, cfg });
  }
}

export async function startChannels(
  cfg: OpenClawConfig,
  deps: ChannelManagerDeps,
): Promise<StartedChannel[]> {
  const plugins = getEnabledChannelPlugins(cfg);
  const started: StartedChannel[] = [];

  for (const plugin of plugins) {
    if (!plugin.transport) {
      console.warn(`[gateway] ${plugin.id}: no transport — skipping`);
      continue;
    }
    console.log(`[gateway] channel registered: ${plugin.id} (${plugin.meta.label})`);

    const connection = await plugin.transport.connect({
      accountId: "default",
      cfg,
      onInbound: async (msg) => {
        const reply = await deps.runAgent(msg.body);
        if (reply) {
          await deliverReply(plugin, cfg, msg.from, reply);
        }
      },
    });
    started.push({ id: plugin.id, connection });
  }

  return started;
}

export async function stopChannels(started: StartedChannel[]): Promise<void> {
  for (const channel of started) {
    await channel.connection.stop();
  }
}
