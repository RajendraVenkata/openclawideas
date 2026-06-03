// Real origin: extensions/whatsapp/src/accounts.ts — resolves a WhatsApp account
// from config. Trimmed to the fields the bare loop uses.
import type { OpenClawConfig } from "openclaw/config/types.openclaw.js";

export type ResolvedWhatsAppAccount = {
  accountId: string;
  dmPolicy: "pairing" | "open";
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
