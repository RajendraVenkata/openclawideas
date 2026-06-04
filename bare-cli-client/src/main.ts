// ──────────────────────────────────────────────────────────────────────────
// CLI client orchestrator:
//   load/prompt config → connect WS → hello-ok → pair (if needed) → chat loop.
// Talks to bare-gateway-loop over the gateway WebSocket (:18789) with one token.
// ──────────────────────────────────────────────────────────────────────────

import { loadConfig, saveConfig, resetConfig, type CliConfig } from "./config.js";
import { createWsClient } from "./ws-client.js";
import { createUi } from "./ui.js";
import { ensurePaired } from "./pairing.js";
import { DEFAULT_ENDPOINT, endpointOverride, parseEndpoint } from "./endpoint.js";

async function firstRunSetup(
  ui: ReturnType<typeof createUi>,
  endpointDefault: string,
): Promise<CliConfig> {
  ui.printSystem("First launch — let's get you set up.");
  const name = (await ui.question("Display name: ")).trim() || "anon";
  const token = (await ui.question("Gateway token: ")).trim();
  const epAnswer = (await ui.question(`Gateway endpoint [${endpointDefault}]: `)).trim();
  const ep = parseEndpoint(epAnswer || endpointDefault);
  const cfg: CliConfig = { name, token, host: ep.host, port: ep.port };
  await saveConfig(cfg);
  return cfg;
}

async function main(): Promise<void> {
  const ui = createUi();
  ui.print("\x1b[1m🦞 bare-cli-client\x1b[0m");

  // `--gateway host:port` / `-g` / BARE_CLI_GATEWAY overrides the saved/default endpoint.
  const override = endpointOverride(process.argv.slice(2), process.env);
  const endpointDefault = override
    ? `${parseEndpoint(override).host}:${parseEndpoint(override).port}`
    : `${DEFAULT_ENDPOINT.host}:${DEFAULT_ENDPOINT.port}`;

  let cfg = await loadConfig();
  if (!cfg) {
    cfg = await firstRunSetup(ui, endpointDefault);
  } else {
    if (override) {
      const ep = parseEndpoint(override);
      cfg.host = ep.host;
      cfg.port = ep.port;
    }
    ui.printSystem(`welcome back, ${cfg.name} (${cfg.host}:${cfg.port})`);
  }

  const ws = createWsClient({ host: cfg.host, port: cfg.port });

  try {
    await ws.connect();
  } catch {
    ui.printError(`cannot reach gateway at ${cfg.host}:${cfg.port} — is it running?`);
    process.exit(1);
  }

  // connect → hello-ok (auth happens here; the token is in params)
  try {
    await ws.req("connect", {
      minProtocol: 4,
      maxProtocol: 4,
      role: "operator",
      auth: { token: cfg.token },
      client: { name: cfg.name },
    });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "UNAUTHORIZED") {
      ui.printError(
        'wrong token — it must equal the gateway\'s gateway.auth.token (default "dev-secret-token").',
      );
      ui.printSystem("fix: rm -rf ~/.bare-cli, then run again and enter the correct token.");
    } else {
      ui.printError(`connect failed (${code ?? String(err)}) — is the gateway running the latest code?`);
    }
    process.exit(1);
  }
  ui.printSystem(`connected as "${cfg.name}"`);

  // Now that we're connected, treat a socket close as the gateway going away.
  ws.on("__close", () => {
    ui.printError("connection closed by gateway");
    process.exit(1);
  });

  // pairing (console code)
  await ensurePaired(ws, ui, cfg.name);

  // incoming agent messages (pushed events)
  ws.on("chat", (payload) => {
    const p = payload as { from?: string; text?: string };
    ui.printAgent(p.text ?? "");
  });

  ui.printSystem("ready — type a message, or /help for commands.");

  ui.startChat((line) => {
    const text = line.trim();
    if (!text) return;
    if (text.startsWith("/")) {
      void handleCommand(text, ui, ws, cfg!);
      return;
    }
    ui.printYou(cfg!.name, text);
    void ws.req("cli.send", { text }).catch(() => ui.printError("send failed"));
  });
}

async function handleCommand(
  cmd: string,
  ui: ReturnType<typeof createUi>,
  ws: ReturnType<typeof createWsClient>,
  cfg: CliConfig,
): Promise<void> {
  const [name] = cmd.slice(1).split(/\s+/);
  switch (name) {
    case "quit":
    case "exit":
      ui.printSystem("bye 👋");
      ws.close();
      ui.close();
      process.exit(0);
      break;
    case "reset":
      await resetConfig();
      ui.printSystem("config cleared — re-run to set up again.");
      ws.close();
      ui.close();
      process.exit(0);
      break;
    case "status":
      ui.printSystem(`name=${cfg.name}  gateway=${cfg.host}:${cfg.port}`);
      break;
    case "help":
      ui.printSystem("commands: /help  /status  /reset  /quit");
      break;
    default:
      ui.printError(`unknown command: /${name} (try /help)`);
  }
}

main().catch((err) => {
  console.error(`fatal: ${String(err)}`);
  process.exit(1);
});
