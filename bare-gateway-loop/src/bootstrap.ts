// ──────────────────────────────────────────────────────────────────────────
// ORCHESTRATOR (the bare loop) — this file is NEW. It is the condensed stand-in
// for the real boot path:
//
//   entry.ts → runCli("gateway") → … → startGatewayServer()      [server.impl.ts]
//                                         → createGatewayHttpServer()  [server-http.ts]
//                                         → listenGatewayHttpServer()  [server/http-listen.ts]
//
// It calls the EXTRACTED REAL functions (steps 1–4) in the same order the real
// gateway does, so you can run it and watch each step happen. The real
// startGatewayServer() is ~700 LOC and wires the full RPC/protocol/plugin stack
// on top of these same primitives — that part is out of scope here.
// ──────────────────────────────────────────────────────────────────────────

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type { OpenClawConfig } from "./config/types.openclaw.js";
import { resolveGatewayPort, resolveGatewayBindHost, isLoopbackHost } from "./config/paths.js";
import { assertExplicitGatewayAuthModeWhenBothConfigured } from "./gateway/auth-mode-policy.js";
import { resolveGatewayAuth, type ResolvedGatewayAuth } from "./gateway/auth-resolve.js";
import { resolveGatewayReloadSettings } from "./gateway/config-reload-settings.js";
import { startGatewayConfigReloader } from "./gateway/config-reload.js";
import { listenGatewayHttpServer } from "./gateway/server/http-listen.js";
import { startChannels, stopChannels, type StartedChannel } from "./channels/channel-manager.js";
import { runAgent } from "./agent/run-agent-stub.js";
// Side-effect imports: register the bundled channel plugins into the catalog.
import "../extensions/whatsapp/src/register.js";
import "../extensions/msteams/src/register.js";

// Reads and JSON-parses a request body (for the simulated-inbound route).
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH ?? path.join(HERE, "..", "openclaw.json");

// The real gateway reads ~/.openclaw/openclaw.json as JSON5. We strip // and /* */
// comments then JSON.parse — faithful enough for the bare loop's sample config.
async function loadConfig(): Promise<OpenClawConfig> {
  const raw = await readFile(CONFIG_PATH, "utf8");
  const noComments = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  return JSON.parse(noComments) as OpenClawConfig;
}

function authSummary(auth: ResolvedGatewayAuth): string {
  const secret = auth.mode === "password" ? auth.password : auth.token;
  const has = secret ? `set (${secret.length} chars)` : "MISSING";
  return `mode=${auth.mode} (source=${auth.modeSource}) secret=${has} allowTailscale=${auth.allowTailscale}`;
}

// ── STEP 4: the single multiplexed HTTP + WebSocket request surface ──────────
// The real createGatewayHttpServer() builds the full handler (Control UI, OpenAI
// compat, plugin routes, hooks, RPC) and attaches the WS server. Here we wire a
// minimal real http.createServer + a real RFC6455 WS upgrade handshake so you can
// see "one port, both protocols", gated by the resolved auth (step 2).
function createBareGatewayHttpServer(
  getAuth: () => ResolvedGatewayAuth,
  channelsById: Map<string, StartedChannel>,
) {
  const isAuthorized = (req: IncomingMessage): boolean => {
    const auth = getAuth();
    if (auth.mode === "none") {
      return true;
    }
    const expected = auth.mode === "password" ? auth.password : auth.token;
    if (!expected) {
      return false;
    }
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : header;
    return presented === expected;
  };

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // WebSocket upgrades are handled by the 'upgrade' event, not here.
    if ((req.headers.upgrade ?? "").toLowerCase() === "websocket") {
      return;
    }
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, surface: "http" }));
      return;
    }

    // STEP 5 — simulated channel inbound: POST /channels/<id>/inbound { from, text }
    // Stands in for a real transport (e.g. Baileys' messages.upsert) delivering a
    // message. The reply is delivered back out the channel (see console 📤), so
    // this just acknowledges acceptance — like a real inbound webhook.
    const inboundMatch = req.url?.match(/^\/channels\/([^/?]+)\/inbound$/);
    if (req.method === "POST" && inboundMatch) {
      if (!isAuthorized(req)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED" } }));
        return;
      }
      const started = channelsById.get(inboundMatch[1]);
      if (!started) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: { code: "NO_SUCH_CHANNEL" } }));
        return;
      }
      const body = await readJsonBody(req);
      await started.connection.simulateInbound(
        String(body.from ?? "unknown"),
        String(body.text ?? ""),
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, channel: started.id, accepted: true }));
      return;
    }

    if (!isAuthorized(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, you: "authorized", path: req.url }));
  });

  // Minimal real WebSocket handshake (single multiplexed port).
  const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  httpServer.on("upgrade", (req: IncomingMessage, socket: Socket) => {
    if (!isAuthorized(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(key + WS_MAGIC).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    // A real gateway now speaks the protocol-v4 frame format here (connect →
    // hello-ok → events). We just confirm the upgrade succeeded.
    console.log("[gateway] websocket client upgraded on the multiplexed port");
  });

  return httpServer;
}

async function main() {
  console.log(`[gateway] booting bare loop — reading config: ${CONFIG_PATH}`);

  // Load the in-memory config snapshot (read once; the reloader swaps it later).
  let cfg = await loadConfig();

  // STEP 2 (guard): fail fast on ambiguous auth before binding anything.
  assertExplicitGatewayAuthModeWhenBothConfigured(cfg);

  // STEP 1: resolve port + bind host.
  const port = resolveGatewayPort(cfg);
  const bindHost = resolveGatewayBindHost(cfg);
  console.log(`[gateway] step 1 — port=${port} bindHost=${bindHost} loopback=${isLoopbackHost(bindHost)}`);
  if (!isLoopbackHost(bindHost)) {
    console.warn("⚠️  step 1 — binding to a non-loopback address (exposed beyond this host).");
  }

  // STEP 2: resolve the auth layer.
  let resolvedAuth = resolveGatewayAuth({
    authConfig: cfg.gateway?.auth ?? null,
    tailscaleMode: cfg.gateway?.tailscale?.mode,
  });
  console.log(`[gateway] step 2 — auth ${authSummary(resolvedAuth)}`);

  // STEP 3: resolve reload settings + start the config watcher.
  const reloadSettings = resolveGatewayReloadSettings(cfg);
  console.log(
    `[gateway] step 3 — reload mode=${reloadSettings.mode} debounceMs=${reloadSettings.debounceMs} (watching ${CONFIG_PATH})`,
  );
  const reloader = startGatewayConfigReloader({
    watchPath: CONFIG_PATH,
    settings: reloadSettings,
    loadConfig,
    onConfig: (next) => {
      cfg = next; // hot-swap the in-memory snapshot
      resolvedAuth = resolveGatewayAuth({
        authConfig: cfg.gateway?.auth ?? null,
        tailscaleMode: cfg.gateway?.tailscale?.mode,
      });
      console.log(`[gateway] step 3 — config reloaded; auth now ${authSummary(resolvedAuth)}`);
    },
  });

  // The channel lookup is created empty now and populated in step 5. The HTTP
  // handler reads it at request time, so late population works (same closure
  // trick as getAuth()).
  const channelsById = new Map<string, StartedChannel>();

  // STEP 4: create the multiplexed HTTP/WS server and bind it.
  const httpServer = createBareGatewayHttpServer(() => resolvedAuth, channelsById);
  await listenGatewayHttpServer({ httpServer, bindHost, port });
  console.log(`[gateway] step 4 — listening on ws://${bindHost}:${port}  (HTTP + WebSocket)`);

  // STEP 5: load enabled channel plugins from the catalog + start their transports.
  const channels = await startChannels(cfg, { runAgent });
  for (const channel of channels) {
    channelsById.set(channel.id, channel);
  }
  console.log(
    `[gateway] step 5 — channels started: ${channels.map((c) => c.id).join(", ") || "(none enabled)"}`,
  );

  console.log("[gateway] ready. Try:");
  console.log(`  curl -s http://${bindHost}:${port}/health`);
  const sampleSecret = resolvedAuth.mode === "password" ? resolvedAuth.password : resolvedAuth.token;
  const auth = `-H "Authorization: Bearer ${sampleSecret ?? "<token>"}"`;
  console.log(`  curl -s ${auth} http://${bindHost}:${port}/whoami`);
  console.log(
    `  curl -s ${auth} -H "content-type: application/json" ` +
      `-d '{"from":"+15551234567","text":"hello"}' ` +
      `http://${bindHost}:${port}/channels/whatsapp/inbound`,
  );
  console.log("  (edit openclaw.json while running to watch step 3 hot-reload)");

  const shutdown = async () => {
    console.log("\n[gateway] shutting down…");
    await stopChannels(channels);
    await reloader.stop();
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[gateway] startup failed: ${String(err)}`);
  process.exit(1);
});
