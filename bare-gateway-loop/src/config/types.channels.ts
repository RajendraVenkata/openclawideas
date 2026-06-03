// ──────────────────────────────────────────────────────────────────────────
// Channel config shapes — origin: openclaw/src/channels/channel-config.ts +
// the per-channel plugin configs (e.g. extensions/whatsapp).
//
// The real product supports ~20 channels (WhatsApp, Telegram, Slack, Discord,
// Signal, iMessage, …). This bare loop models only WhatsApp to keep it simple.
// ──────────────────────────────────────────────────────────────────────────

export type WhatsAppChannelConfig = {
  /** Whether the gateway should load + start this channel. */
  enabled?: boolean;
  /** Which WhatsApp account this binds to (real product supports several). */
  accountId?: string;
  /** How to treat DMs from unknown senders. Real default is "pairing". */
  dmPolicy?: "pairing" | "open";
};

export type MSTeamsChannelConfig = {
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

export type ChannelsConfig = {
  whatsapp?: WhatsAppChannelConfig;
  msteams?: MSTeamsChannelConfig;
  // telegram?: …  slack?: …  discord?: …  (omitted in the bare loop)
};
