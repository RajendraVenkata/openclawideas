// ──────────────────────────────────────────────────────────────────────────
// Channel config shapes — origin: openclaw/src/channels/channel-config.ts +
// the per-channel plugin configs (e.g. extensions/whatsapp).
//
// The real product supports ~20 channels (WhatsApp, Telegram, Slack, Discord,
// Signal, iMessage, …). This bare loop models only WhatsApp to keep it simple.
// ──────────────────────────────────────────────────────────────────────────

import type { DmPolicy } from "../channels/security/allow-from.js";

// Inbound security shared by every channel (real openclaw applies these per channel).
export type ChannelSecurityConfig = {
  /** How to treat inbound DMs from unknown senders. Default "pairing" (secure). */
  dmPolicy?: DmPolicy;
  /** Allowlisted sender ids. "*" = everyone. Approved pairings are added at runtime. */
  allowFrom?: Array<string | number>;
};

export type WhatsAppChannelConfig = ChannelSecurityConfig & {
  /** Whether the gateway should load + start this channel. */
  enabled?: boolean;
  /** Which WhatsApp account this binds to (real product supports several). */
  accountId?: string;
};

export type MSTeamsChannelConfig = ChannelSecurityConfig & {
  enabled?: boolean;
  accountId?: string;
  /** Bot Framework app (client) id. */
  appId?: string;
  /** Azure AD tenant id. */
  tenantId?: string;
  /** Bot Framework app secret. When unset, the webhook runs in local/emulator mode (JWT validation off). */
  appPassword?: string;
  /** Inbound messaging endpoint (Bot Framework). Defaults: port 3978, path /api/messages. */
  webhook?: {
    port?: number;
    path?: string;
  };
};

export type WebhookChannelConfig = ChannelSecurityConfig & {
  enabled?: boolean;
  accountId?: string;
  /** Inbound HTTP webhook (own port). */
  inbound?: {
    port?: number;
    path?: string;
    /** Shared secret required in X-Webhook-Secret. Unset = no check (local mode). */
    secret?: string;
  };
  /** Where to POST the agent's reply. Unset = print instead. */
  outbound?: {
    url?: string;
  };
};

export type ChannelsConfig = {
  whatsapp?: WhatsAppChannelConfig;
  msteams?: MSTeamsChannelConfig;
  webhook?: WebhookChannelConfig;
  // telegram?: …  slack?: …  discord?: …  (omitted in the bare loop)
};
