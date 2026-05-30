/**
 * Simplest possible smoke test: connect, call `health`, print the result.
 *
 *   $ npm run health
 *
 * Useful to confirm:
 *   - the container is reachable on OPENCLAW_GATEWAY_URL
 *   - your OPENCLAW_GATEWAY_TOKEN is correct
 *   - the WS handshake works end-to-end
 *
 * If this prints a healthy response, you're good to run `npm run bootstrap`.
 */

import { GatewayClient, readEnv } from "./client.js";

async function main(): Promise<void> {
  const { url, token } = readEnv();
  const client = new GatewayClient({ url, token });

  console.log(`→ connecting to ${url}`);
  const hello = await client.connect();
  console.log("✓ hello-ok");
  console.log(`  server.version  : ${hello.server.version}`);
  console.log(`  server.connId   : ${hello.server.connId}`);
  console.log(`  protocol        : ${hello.protocol}`);
  console.log(`  negotiated role : ${hello.auth.role}`);
  console.log(`  negotiated scope: ${hello.auth.scopes.join(", ")}`);
  console.log(
    `  policy          : maxPayload=${hello.policy.maxPayload}  tick=${hello.policy.tickIntervalMs}ms`,
  );

  console.log("\n→ rpc: health");
  const health = await client.rpc("health", {});
  console.log("✓ health:", JSON.stringify(health, null, 2));

  await client.close();
}

main().catch((err) => {
  console.error("✗ failed:", err.message ?? err);
  process.exit(1);
});
