// ──────────────────────────────────────────────────────────────────────────
// Channel plugin catalog (registry).
// Real origin: src/channels/plugins/catalog.ts + the plugin loader (src/plugins/*).
// The real catalog tracks every registered channel plugin (bundled + external);
// the gateway then materializes the ones that are enabled in config.
//
// Bundled plugins register themselves at import time. We do the same: importing
// extensions/whatsapp/src/register.ts calls registerChannelPlugin(whatsappPlugin).
// ──────────────────────────────────────────────────────────────────────────

import type { ChannelId, ChannelPlugin } from "../../plugin-sdk/channel-core.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChannelsConfig } from "../../config/types.channels.js";

const registry = new Map<ChannelId, ChannelPlugin>();

export function registerChannelPlugin(plugin: ChannelPlugin): void {
  registry.set(plugin.id, plugin);
}

export function getChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  return registry.get(id);
}

// Return every registered plugin whose channel is enabled in config
// (`channels.<id>.enabled`). Real loader also checks installs/allow-deny.
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
