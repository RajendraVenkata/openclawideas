// ──────────────────────────────────────────────────────────────────────────
// Real origin: extensions/msteams/src/send.ts — sends a *proactive* message via
// the Bot Framework: it resolves a stored conversation reference + a CloudAdapter
// and calls `adapter.continueConversation(...)`. Note the real export takes a
// PARAMS OBJECT (`{ cfg, to, text, mediaUrl, … }`), unlike WhatsApp's positional
// `sendMessageWhatsApp(to, text, opts)`. We keep the params-object shape; the body
// is simulated.
// ──────────────────────────────────────────────────────────────────────────

export type SendMSTeamsMessageParams = {
  to: string;
  text: string;
  replyToId?: string | null;
};

export type SendMSTeamsMessageResult = {
  messageId: string;
};

export async function sendMessageMSTeams(
  params: SendMSTeamsMessageParams,
): Promise<SendMSTeamsMessageResult> {
  // REAL: resolve { adapter, conversationId, ref } then
  //       adapter.continueConversation(ref, (ctx) => ctx.sendActivity({ text }))
  console.log(`📤 [msteams → ${params.to}] ${params.text}`);
  return { messageId: `msteams.SIMULATED.${params.to}` };
}
