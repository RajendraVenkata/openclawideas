// The cli channel's leaf send: push the reply to the recipient's WS connection(s)
// as a `chat` event (real openclaw pushes events to connected clients over WS).
import { pushToCli } from "openclaw/gateway/ws-hub.js";

export async function sendMessageCli(params: {
  to: string;
  text: string;
}): Promise<{ messageId: string }> {
  const delivered = pushToCli(params.to, { channel: "cli", from: "agent", text: params.text });
  if (delivered === 0) {
    console.log(`[cli] no live connection for ${params.to} — dropped reply`);
  }
  return { messageId: `cli.${Date.now()}` };
}
