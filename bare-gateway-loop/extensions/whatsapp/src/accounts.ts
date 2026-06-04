// Real origin: extensions/whatsapp/src/accounts.ts — resolves a WhatsApp account
// from config. Trimmed to the fields the bare loop uses.
import type { OpenClawConfig } from "openclaw/config/types.openclaw.js";
import type { DmPolicy } from "openclaw/channels/security/allow-from.js";

export type ResolvedWhatsAppAccount = {
  accountId: string;
  dmPolicy: DmPolicy;
};

export function resolveWhatsAppAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedWhatsAppAccount {
  const wa = params.cfg.channels?.whatsapp ?? {};
  return {
    accountId: params.accountId ?? wa.accountId ?? "default",
    dmPolicy: wa.dmPolicy ?? "pairing",
  };
}
