/**
 * Live event watcher. Subscribes to session + presence events and prints
 * them as they arrive. Use this to confirm channels are wired up:
 *
 *   $ npm run watch
 *
 * Then DM the bot from Telegram (or trigger any channel inbound) and
 * you should see `session.message` / `sessions.changed` events appear.
 *
 * Ctrl-C to stop.
 */

import { GatewayClient, readEnv } from "./client.js";

async function main(): Promise<void> {
  const { url, token } = readEnv();
  const client = new GatewayClient({ url, token });

  console.log(`→ connecting to ${url}`);
  await client.connect();
  console.log("✓ connected. watching events. Ctrl-C to stop.\n");

  // Subscribe to all session changes.
  await client.rpc("sessions.subscribe", {});

  const noisy = new Set(["tick", "heartbeat"]);

  client.onEvent((ev) => {
    if (noisy.has(ev.event)) return;
    const ts = new Date().toISOString();
    const payloadStr = ev.payload
      ? truncate(JSON.stringify(ev.payload), 600)
      : "";
    console.log(
      `[${ts}] ${ev.event}${ev.seq !== undefined ? ` seq=${ev.seq}` : ""}${
        payloadStr ? "\n  " + payloadStr : ""
      }`,
    );
  });

  // Keep the process alive until Ctrl-C.
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => resolve());
    process.on("SIGTERM", () => resolve());
  });

  console.log("\n→ closing");
  await client.close();
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "...(truncated)" : s;
}

main().catch((err) => {
  console.error("✗ failed:", (err as Error).message ?? err);
  process.exit(1);
});
