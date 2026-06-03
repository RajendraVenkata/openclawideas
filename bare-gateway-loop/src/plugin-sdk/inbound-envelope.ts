// ──────────────────────────────────────────────────────────────────────────
// Inbound routing + envelope — FAITHFUL SUBSET.
// Real origin: src/plugin-sdk/inbound-envelope.ts (createInboundEnvelopeBuilder,
// resolveInboundRouteEnvelopeBuilder).
//
// In the real gateway, an inbound message is (1) routed to an { agentId,
// sessionKey } via bindings, then (2) formatted into an agent-facing "envelope"
// (the text the model sees, with channel/from/timestamp context). We keep both
// steps, minimally.
// ──────────────────────────────────────────────────────────────────────────

import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ChannelId } from "./channel-core.js";

// Where a message is delivered (real fields: agentId, sessionKey).
export type Route = {
  agentId: string;
  sessionKey: string;
};

// Who/where it came from (real fields: kind, id).
export type RoutePeer = {
  kind: "direct" | "group" | "channel";
  id: string | number;
};

// Resolve a route from (channel, accountId, peer). The real resolver walks the
// most-specific binding (peer → guild+roles → account → channel → default). We
// use the default-agent + a per-peer DM session key, which is the common case.
export function resolveInboundRoute(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId: string;
  peer: RoutePeer;
}): Route {
  const agentId = "main";
  const sessionKey =
    params.peer.kind === "direct"
      ? `agent:${agentId}:main`
      : `agent:${agentId}:${params.channel}:${params.peer.kind}:${params.peer.id}`;
  return { agentId, sessionKey };
}

// Format the agent-facing envelope text (real: formatAgentEnvelope). The model
// sees who/where the message came from, not just the raw body.
export function formatInboundEnvelope(input: {
  channel: ChannelId;
  from: string;
  body: string;
  timestamp: number;
}): string {
  return `[${input.channel}] from ${input.from}: ${input.body}`;
}
