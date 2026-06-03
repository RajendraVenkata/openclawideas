// Real origin: extensions/msteams/src/accounts.ts — resolves a Microsoft Teams
// account (Bot Framework app credentials) from config. Trimmed to a few fields.
import type { OpenClawConfig } from "openclaw/config/types.openclaw.js";

export type ResolvedMSTeamsAccount = {
  accountId: string;
  appId: string;
  tenantId?: string;
};

export function resolveMSTeamsAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedMSTeamsAccount {
  const teams = params.cfg.channels?.msteams ?? {};
  return {
    accountId: params.accountId ?? teams.accountId ?? "default",
    appId: teams.appId ?? "",
    tenantId: teams.tenantId,
  };
}
