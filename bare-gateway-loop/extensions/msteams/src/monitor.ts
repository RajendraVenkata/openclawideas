// ──────────────────────────────────────────────────────────────────────────
// Real origin: extensions/msteams/src/monitor.ts → monitorMSTeamsProvider.
// This is the MS Teams "read" path: it stands up the Bot Framework messaging
// endpoint (POST /api/messages on port 3978), and for each inbound request:
//   1. a pre-parse Bearer auth gate (cheap reject before body parsing)
//   2. JWT validation (createBotFrameworkJwtValidator — local mode skips it)
//   3. adapter.process(activity, ctx => handler.run(ctx))   ← dispatch by type
//
// Faithful to the real structure/names; the real one uses Express + the
// @microsoft/teams SDK adapter. We use Node http + direct Activity parsing so it
// runs offline (you can POST a sample Activity to test it — see README).
// ──────────────────────────────────────────────────────────────────────────

import { createServer, type IncomingMessage } from "node:http";
import type { InboundHandler, OpenClawConfig } from "openclaw/plugin-sdk/channel-core.js";
import { resolveMSTeamsCredentials } from "./token.js";
import {
  createBotFrameworkJwtValidator,
  createMSTeamsAdapter,
  createMSTeamsTokenProvider,
  loadMSTeamsSdkWithAuth,
} from "./sdk.js";
import {
  buildActivityHandler,
  registerMSTeamsHandlers,
  type MSTeamsActivity,
} from "./monitor-handler.js";
import {
  createMSTeamsConversationStoreMemory,
  type MSTeamsConversationStore,
} from "./conversation-store.js";

export type MonitorMSTeamsOpts = {
  cfg: OpenClawConfig;
  onInbound: InboundHandler;
  conversationStore?: MSTeamsConversationStore;
};

export type MonitorMSTeamsResult = {
  app: unknown;
  shutdown: () => Promise<void>;
};

function readActivity(req: IncomingMessage): Promise<MSTeamsActivity> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}") as MSTeamsActivity);
      } catch {
        resolve({});
      }
    });
  });
}

export async function monitorMSTeamsProvider(
  opts: MonitorMSTeamsOpts,
): Promise<MonitorMSTeamsResult> {
  const cfg = opts.cfg;
  const msteamsCfg = cfg.channels?.msteams;
  if (!msteamsCfg?.enabled) {
    return { app: null, shutdown: async () => {} };
  }

  const creds = resolveMSTeamsCredentials(msteamsCfg);
  if (!creds) {
    console.error("[msteams] credentials not configured (need channels.msteams.appId)");
    return { app: null, shutdown: async () => {} };
  }
  const appId = creds.appId;

  const port = msteamsCfg.webhook?.port ?? 3978;
  const configuredPath = msteamsCfg.webhook?.path ?? "/api/messages";
  const conversationStore = opts.conversationStore ?? createMSTeamsConversationStoreMemory();

  const { sdk, app } = await loadMSTeamsSdkWithAuth(creds);
  createMSTeamsTokenProvider(app); // Graph token provider (unused in read path)
  const adapter = createMSTeamsAdapter(app, sdk);
  const jwtValidator = createBotFrameworkJwtValidator(creds);

  const handler = buildActivityHandler();
  registerMSTeamsHandlers(handler, {
    onInbound: opts.onInbound,
    conversationStore,
    appId,
    log: (msg) => console.log(`[msteams] ${msg}`),
  });

  const messagePaths = new Set([configuredPath, "/api/messages"]);

  const httpServer = createServer(async (req, res) => {
    const url = (req.url ?? "").split("?")[0];
    if (req.method !== "POST" || !messagePaths.has(url)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    // (1) pre-parse Bearer gate + (2) JWT validation
    const verdict = jwtValidator.validate(req.headers.authorization);
    if (!verdict.ok) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized", reason: verdict.reason }));
      return;
    }
    // (3) parse the Activity and run the handler chain
    const activity = await readActivity(req);
    try {
      await adapter.process(activity, (context) => handler.run!(context));
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    } catch (err) {
      console.error(`[msteams] webhook failed: ${String(err)}`);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error" }));
    }
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
    `[msteams] webhook listening on http://127.0.0.1:${port}${configuredPath} (Bot Framework messages endpoint)`,
  );
  if (jwtValidator.localMode) {
    console.warn(
      "[msteams] JWT validation DISABLED — local/emulator mode (no channels.msteams.appPassword set)",
    );
  }

  const shutdown = async (): Promise<void> => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    console.log("[msteams] webhook stopped");
  };

  return { app, shutdown };
}
