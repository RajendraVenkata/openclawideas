/**
 * Simplest possible smoke test: connect via @openclaw/sdk and call health.
 *
 *   $ ./run-in-sidecar.sh health
 *
 * Confirms:
 *   - the container is reachable on OPENCLAW_GATEWAY_URL
 *   - your OPENCLAW_GATEWAY_TOKEN is correct
 *   - the WS handshake + SDK transport work end-to-end
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

  // The SDK exposes namespaces (oc.models, oc.agents, ...) but no raw-RPC
  // method. We construct the transport ourselves so we can call `health`
  // (which isn't in any SDK namespace) directly.
  const transport = new GatewayClientTransport({ url, token });
  const oc = new OpenClaw({ transport });

  console.log(`→ connecting to ${url}`);
  await oc.connect();
  console.log("✓ connected via @openclaw/sdk");

  console.log("\n→ rpc: health");
  const health = await transport.request("health", {});
  console.log("✓ health:", JSON.stringify(health, null, 2));

  console.log("\n→ rpc: agents.list (via SDK namespace)");
  const agents = await oc.agents.list();
  console.log("✓ agents:", JSON.stringify(agents, null, 2));

  await oc.close();
}

main().catch((err) => {
  console.error("✗ failed:", err.message ?? err);
  process.exit(1);
});
