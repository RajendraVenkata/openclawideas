// Config shapes for the custom webhook channel demo.

export type WebhookChannelConfig = {
  enabled?: boolean;
  inbound?: {
    /** Port the inbound webhook listens on (own port, like a real channel). */
    port?: number;
    /** Path the inbound webhook is served at. */
    path?: string;
    /** Shared secret required in the X-Webhook-Secret header. Unset = no check (local mode). */
    secret?: string;
  };
  outbound?: {
    /** Where to POST the agent's reply. Unset = print the reply instead. */
    url?: string;
  };
};

export type ChannelsConfig = {
  webhook?: WebhookChannelConfig;
};

export type OpenClawConfig = {
  channels?: ChannelsConfig;
};
