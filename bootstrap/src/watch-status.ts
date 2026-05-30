/**
 * Live event watcher using @openclaw/sdk's rawEvents async iterator.
 *
 *   $ ./run-in-sidecar.sh watch
 *
 * Subscribes to sessions changes via transport.request, then iterates over
 * oc.rawEvents() to print everything except noisy heartbeats/ticks.
 *
 * Ctrl-C to stop.
 */

import { GatewayClientTransport, OpenClaw } from "@openclaw/sdk";

function readEnv(): { url: string; token: string } {
  const url = process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18789";
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) throw new Error("OPENCLAW_GATEWAY_TOKEN is not set.");
  return { url, token };
}

async function main(): Promise<void> {
  const { url, token } = readEnv();
  const transport = new GatewayClientTransport({ url, token });
  const oc = new OpenClaw({ transport });

  console.log(`→ connecting to ${url}`);
  await oc.connect();
  console.log("✓ connected. watching events. Ctrl-C to stop.\n");

  // Opt in to per-session events.
  await transport.request("sessions.subscribe", {});

  const noisy = new Set(["tick", "heartbeat"]);

  // Run the event loop in the background while we wait for a signal.
  const stop = new AbortController();
  const consumePromise = consumeEvents(oc, noisy, stop.signal);

  await new Promise<void>((resolve) => {
    const onSig = () => {
      stop.abort();
      resolve();
    };
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);
  });

  console.log("\n→ closing");
  await oc.close();
  await consumePromise.catch(() => {});
}

async function consumeEvents(
  oc: OpenClaw,
  noisy: Set<string>,
  signal: AbortSignal,
): Promise<void> {
  for await (const ev of oc.rawEvents()) {
    if (signal.aborted) return;
    const eventName = (ev as { event?: string }).event ?? "(unknown)";
    if (noisy.has(eventName)) continue;
    const ts = new Date().toISOString();
    const payload = (ev as { payload?: unknown }).payload;
    const seq = (ev as { seq?: number }).seq;
    const payloadStr = payload ? truncate(JSON.stringify(payload), 600) : "";
    console.log(
      `[${ts}] ${eventName}${seq !== undefined ? ` seq=${seq}` : ""}${
        payloadStr ? "\n  " + payloadStr : ""
      }`,
    );
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "...(truncated)" : s;
}

main().catch((err) => {
  console.error("✗ failed:", (err as Error).message ?? err);
  process.exit(1);
});
