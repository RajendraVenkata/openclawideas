// Leaf send: POST the reply to the configured outbound URL (async), or print
// when no URL is set. Reads the URL from the in-memory config (threaded through
// the send context).
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core.js";

export async function sendMessageWebhook(params: {
  to: string;
  text: string;
  cfg: OpenClawConfig;
}): Promise<{ messageId: string }> {
  const url = params.cfg.channels?.webhook?.outbound?.url;
  const messageId = `webhook.${Date.now()}`;

  if (!url) {
    console.log(`📤 [webhook → ${params.to}] ${params.text}  (no outbound.url set — printed)`);
    return { messageId };
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: params.to, text: params.text }),
    });
    console.log(`📤 [webhook → ${params.to}] POST ${url} → ${res.status}`);
  } catch (err) {
    console.error(`[webhook] outbound POST to ${url} failed: ${String(err)}`);
  }
  return { messageId };
}
