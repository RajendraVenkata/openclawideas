// Stand-in for the agent. Real OpenClaw runs the message through the Pi agent
// loop (model + tools); here we just echo so you can watch the channel plumbing.
export async function runAgent(text: string): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  return `🤖 (echo agent) you said: "${trimmed}" — ${trimmed.length} chars`;
}
