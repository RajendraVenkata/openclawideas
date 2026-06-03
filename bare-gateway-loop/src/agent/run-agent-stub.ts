// ──────────────────────────────────────────────────────────────────────────
// STAND-IN for the agent — real origin: the embedded Pi agent runtime
// (runEmbeddedPiAgent) reached via src/gateway/boot.ts → agentCommand. The real
// agent assembles context, calls the model, runs tools, and streams a reply.
// Here we echo so you can watch the channel plumbing end to end.
// ──────────────────────────────────────────────────────────────────────────

export async function runAgent(envelopeText: string): Promise<string | null> {
  const text = envelopeText.trim();
  if (!text) {
    return null;
  }
  return `🤖 (echo agent) ${text} — ${text.length} chars`;
}
