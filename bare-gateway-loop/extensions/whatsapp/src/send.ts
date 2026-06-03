// ──────────────────────────────────────────────────────────────────────────
// Real origin: extensions/whatsapp/src/send.ts — the leaf that actually talks to
// the WhatsApp transport (Baileys `sock.sendMessage(jid, { text })`).
// Here it just prints. Same NAME + signature shape as the real export.
// ──────────────────────────────────────────────────────────────────────────

export type SendMessageWhatsAppOptions = {
  replyToId?: string | null;
  preserveLeadingWhitespace?: boolean;
};

export async function sendMessageWhatsApp(
  to: string,
  text: string,
  _options: SendMessageWhatsAppOptions = {},
): Promise<{ messageId: string }> {
  // REAL: const jid = jidFromNumber(to); await sock.sendMessage(jid, { text });
  console.log(`📤 [whatsapp → ${to}] ${text}`);
  return { messageId: `wamid.SIMULATED.${to}` };
}

export async function sendTypingWhatsApp(_to: string): Promise<void> {
  // REAL: await sock.sendPresenceUpdate("composing", jid)
}
