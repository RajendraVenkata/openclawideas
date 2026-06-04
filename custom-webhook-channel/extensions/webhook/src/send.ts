// The leaf "send": POSTs the reply to the configured outbound URL (async
// delivery). If no outbound.url is configured, it prints instead — so the demo
// runs offline out of the box.

import type { OpenClawConfig } from "openclaw/config-types.js";

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
