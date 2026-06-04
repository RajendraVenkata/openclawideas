// ──────────────────────────────────────────────────────────────────────────
// The runner: load config → start the (registered) channels → wait.
// ──────────────────────────────────────────────────────────────────────────

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type { OpenClawConfig } from "./config-types.js";
import { startChannels, stopChannels, type StartedChannel } from "./channel-manager.js";
import { runAgent } from "./agent-stub.js";
// Side-effect import: registers the webhook plugin into the catalog.
import "../extensions/webhook/src/register.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH ?? path.join(HERE, "..", "openclaw.json");

async function loadConfig(): Promise<OpenClawConfig> {
  const raw = await readFile(CONFIG_PATH, "utf8");
  const noComments = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  return JSON.parse(noComments) as OpenClawConfig;
}

async function main(): Promise<void> {
  console.log(`[gateway] booting custom webhook channel — config: ${CONFIG_PATH}`);
  const cfg = await loadConfig();

  const channels = await startChannels(cfg, { runAgent });
  console.log(
    `[gateway] channels started: ${channels.map((c) => c.id).join(", ") || "(none enabled)"}`,
  );
  console.log("[gateway] ready. Try (in another terminal):");
  const wh = cfg.channels?.webhook?.inbound;
  const port = wh?.port ?? 4000;
  const reqPath = wh?.path ?? "/webhook/inbound";
  const secret = wh?.secret;
  const secretHeader = secret ? `-H "X-Webhook-Secret: ${secret}" ` : "";
  console.log(
    `  curl -s ${secretHeader}-H "content-type: application/json" ` +
      `-d '{"from":"alice","text":"hello"}' http://127.0.0.1:${port}${reqPath}`,
  );

  const shutdown = async (): Promise<void> => {
    console.log("\n[gateway] shutting down…");
    await stopChannels(channels);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[gateway] startup failed: ${String(err)}`);
  process.exit(1);
});
