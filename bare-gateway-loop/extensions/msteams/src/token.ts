// ──────────────────────────────────────────────────────────────────────────
// Real origin: extensions/msteams/src/token.ts → resolveMSTeamsCredentials.
// Pulls the Bot Framework app id / tenant / secret from config or env. The real
// version also handles federated/certificate auth; we keep the common case.
// ──────────────────────────────────────────────────────────────────────────

import type { MSTeamsChannelConfig } from "openclaw/config/types.channels.js";

export type MSTeamsCredentials = {
  appId: string;
  tenantId?: string;
  appPassword?: string;
};

function trim(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t && t.length > 0 ? t : undefined;
}

export function resolveMSTeamsCredentials(
  cfg?: MSTeamsChannelConfig,
): MSTeamsCredentials | undefined {
  const appId = trim(cfg?.appId) ?? trim(process.env.MSTEAMS_APP_ID);
  if (!appId) {
    // Real requires appId (and tenantId); without an appId there is no bot.
    return undefined;
  }
  return {
    appId,
    tenantId: trim(cfg?.tenantId) ?? trim(process.env.MSTEAMS_TENANT_ID),
    appPassword: trim(cfg?.appPassword) ?? trim(process.env.MSTEAMS_APP_PASSWORD),
  };
}
