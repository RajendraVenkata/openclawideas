// Inbound webhook ("read" path): an HTTP server on its own port. POST <path> →
// verify shared secret → 202 ack → route to onInbound (the loop's manager/agent).
import { createServer, type IncomingMessage } from "node:http";
import type { InboundHandler, OpenClawConfig } from "openclaw/plugin-sdk/channel-core.js";

export type MonitorWebhookOpts = {
  cfg: OpenClawConfig;
  onInbound: InboundHandler;
};
export type MonitorWebhookResult = { shutdown: () => Promise<void> };

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

export async function monitorWebhookProvider(
  opts: MonitorWebhookOpts,
): Promise<MonitorWebhookResult> {
  const inbound = opts.cfg.channels?.webhook?.inbound;
  const port = inbound?.port ?? 4000;
  const reqPath = inbound?.path ?? "/webhook/inbound";
  const secret = inbound?.secret;

  const httpServer = createServer(async (req, res) => {
    const url = (req.url ?? "").split("?")[0];
    if (req.method !== "POST" || url !== reqPath) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    if (secret) {
      const presented = req.headers["x-webhook-secret"];
      if (presented !== secret) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }
    const body = await readJsonBody(req);
    const from = String(body.from ?? "unknown");
    const text = String(body.text ?? "");

    // Ack immediately; reply is delivered out-of-band (async).
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, accepted: true }));

    console.log(`📥 [webhook ← ${from}] ${text}`);
    void opts.onInbound({ channel: "webhook", from, body: text, timestamp: Date.now() });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: unknown) => {
      httpServer.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(port, "127.0.0.1");
  });

  console.log(
    `[webhook] inbound listening on http://127.0.0.1:${port}${reqPath}` +
      (secret ? " (X-Webhook-Secret required)" : " (no secret — local mode)"),
  );

  const shutdown = async (): Promise<void> => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    console.log("[webhook] inbound stopped");
  };
  return { shutdown };
}
