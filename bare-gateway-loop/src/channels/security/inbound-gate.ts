// ──────────────────────────────────────────────────────────────────────────
// The inbound security gate — the shared "is this sender allowed?" decision that
// real openclaw applies to every inbound DM before running the agent.
//
// Per the channel's dmPolicy:
//   "open"      → process everyone
//   "disabled"  → drop (DMs off)
//   "allowlist" → process only config allowFrom (no pairing, store ignored)
//   "pairing"   → process if in (config allowFrom + the PERSISTED approved store);
//                 else signal "pair" (caller issues a code & awaits approval)
//
// The approved set is read from the persistent pairing store (src/pairing/*), so
// approvals survive restarts.
// ──────────────────────────────────────────────────────────────────────────

import type { ChannelId, OpenClawConfig } from "../../plugin-sdk/channel-core.js";
import {
  compileAllow,
  isSenderIdAllowed,
  mergeDmAllowFromSources,
  type DmPolicy,
} from "./allow-from.js";
import { readChannelAllowFromStore } from "../../pairing/pairing-store.js";

export type InboundAccess =
  | { action: "process" }
  | { action: "pair" }
  | { action: "deny"; reason: string };

type ChannelSecurity = { dmPolicy: DmPolicy; allowFrom: Array<string | number> };

// Read dmPolicy/allowFrom for a channel from config. Default policy = "pairing"
// (secure by default — matches real openclaw).
function resolveChannelSecurity(cfg: OpenClawConfig, channel: ChannelId): ChannelSecurity {
  const channels = cfg.channels as
    | Record<string, { dmPolicy?: DmPolicy; allowFrom?: Array<string | number> } | undefined>
    | undefined;
  const channelCfg = channels?.[channel];
  return {
    dmPolicy: channelCfg?.dmPolicy ?? "pairing",
    allowFrom: channelCfg?.allowFrom ?? [],
  };
}

export async function resolveInboundAccess(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  sender: string;
  accountId?: string;
}): Promise<InboundAccess> {
  const { dmPolicy, allowFrom } = resolveChannelSecurity(params.cfg, params.channel);

  if (dmPolicy === "disabled") {
    return { action: "deny", reason: "dmPolicy=disabled" };
  }
  if (dmPolicy === "open") {
    return { action: "process" };
  }

  // config allowFrom + the persisted approved store (store ignored for allowlist).
  const storeAllowFrom = await readChannelAllowFromStore(
    params.channel,
    process.env,
    params.accountId ?? "default",
  );
  const merged = mergeDmAllowFromSources({ allowFrom, storeAllowFrom, dmPolicy });
  const allowed = isSenderIdAllowed(compileAllow(merged), params.sender, /* allowWhenEmpty */ false);
  if (allowed) {
    return { action: "process" };
  }

  if (dmPolicy === "allowlist") {
    return { action: "deny", reason: "not in allowlist" };
  }

  // dmPolicy === "pairing": caller issues a pairing challenge.
  return { action: "pair" };
}
