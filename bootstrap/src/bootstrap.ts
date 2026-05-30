/**
 * End-to-end Gateway configuration over WebSocket.
 *
 *   $ npm run bootstrap
 *
 * What it does (each step is idempotent and gated by env vars — set only
 * what you want to configure):
 *
 *   1. Connect + verify hello-ok.
 *   2. Health check.
 *   3. Read current models / channels / agents (snapshot of state-before).
 *   4. Apply default workspace + model + provider key
 *      (if ANTHROPIC_API_KEY is set).
 *   5. Register the Telegram channel
 *      (if TELEGRAM_BOT_TOKEN and TELEGRAM_USER_ID are set).
 *   6. Start the Telegram channel.
 *   7. Verify final status with a live channel probe.
 *
 * Grounded in the repo:
 *   - methods: src/gateway/methods/core-descriptors.ts
 *   - param schemas: src/gateway/protocol/schema/channels.ts, config.ts,
 *     agents-models-skills.ts
 *
 * Key correctness note from config.ts: ConfigPatchParams.raw is a STRING
 * (JSON5 text), NOT an object. Always pass JSON.stringify(...).
 */

import { GatewayClient, readEnv } from "./client.js";

const WORKSPACE_PATH = "/home/node/.openclaw/workspace";

async function main(): Promise<void> {
  const { url, token } = readEnv();
  const client = new GatewayClient({ url, token });

  console.log(`→ connecting to ${url}`);
  const hello = await client.connect();
  console.log(`✓ connected to OpenClaw ${hello.server.version}`);
  console.log(`  scopes negotiated: ${hello.auth.scopes.join(", ")}`);

  await step("health", async () => {
    const r = await client.rpc("health", {});
    return r;
  });

  // === Snapshot state-before ===
  await step("models.list (state-before)", async () => {
    return client.rpc("models.list", { view: "configured" });
  });

  await step("channels.status (state-before)", async () => {
    return client.rpc("channels.status", {});
  });

  await step("agents.list (state-before)", async () => {
    return client.rpc("agents.list", {});
  });

  // === Provider key + default model ===
  // Configure whichever provider keys are set. Both can coexist.
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  // Pick a default model based on what's available, unless overridden.
  const defaultModel =
    process.env.OPENCLAW_DEFAULT_MODEL ||
    (openaiKey
      ? "openai/gpt-5.5"
      : anthropicKey
        ? "anthropic/claude-sonnet-4-6"
        : "");

  if (openaiKey || anthropicKey) {
    type ProviderConfig = { apiKey: string; baseUrl: string };
    const providers: Record<string, ProviderConfig> = {};
    if (openaiKey) {
      providers["openai"] = {
        apiKey: openaiKey,
        // The Gateway's config validator requires baseUrl to be a non-empty
        // string when an openai provider block is declared. Override via
        // OPENAI_BASE_URL if you're using Azure OpenAI / vLLM / a proxy.
        baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      };
    }
    if (anthropicKey) {
      providers["anthropic"] = {
        apiKey: anthropicKey,
        baseUrl:
          process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
      };
    }

    const configured = Object.keys(providers).join(" + ");

    await step(`config.patch — ${configured} provider + default model`, async () => {
      const patch = {
        models: { providers },
        agents: {
          defaults: {
            workspace: WORKSPACE_PATH,
            model: defaultModel,
          },
        },
        // Recommended for any setup that may serve multiple senders.
        // Docs: docs/concepts/session.md (DM isolation section).
        session: { dmScope: "per-channel-peer" },
      };
      return configPatch(client, patch);
    });

    await step("models.list (configured)", async () => {
      return client.rpc("models.list", { view: "configured" });
    });

    await step("models.authStatus", async () => {
      return client.rpc("models.authStatus", {});
    });
  } else {
    console.log(
      "⊘ skipping model setup — set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env",
    );
  }

  // === Telegram channel ===
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramUserId = process.env.TELEGRAM_USER_ID;

  if (telegramToken && telegramUserId) {
    await step("config.patch — Telegram channel", async () => {
      const patch = {
        channels: {
          telegram: {
            enabled: true,
            botToken: telegramToken,
            // allowlist is fully WS-driven; we skip the local CLI pairing flow.
            dmPolicy: "allowlist",
            allowFrom: [telegramUserId],
            groupPolicy: "allowlist",
          },
        },
      };
      return configPatch(client, patch);
    });

    await step("channels.start telegram", async () => {
      return client.rpc("channels.start", { channel: "telegram" });
    });

    await step("channels.status telegram (probed)", async () => {
      return client.rpc("channels.status", {
        channel: "telegram",
        probe: true,
        timeoutMs: 8000,
      });
    });
  } else {
    console.log(
      "⊘ skipping Telegram setup — set TELEGRAM_BOT_TOKEN and TELEGRAM_USER_ID in .env",
    );
  }

  // === Final snapshot ===
  await step("channels.status (final)", async () => {
    return client.rpc("channels.status", { probe: true, timeoutMs: 8000 });
  });

  await step("agents.list (final)", async () => {
    return client.rpc("agents.list", {});
  });

  console.log("\n✓ bootstrap complete");
  await client.close();
}

/**
 * Patch config with optimistic-concurrency `baseHash`.
 *
 * The Gateway requires a baseHash on config writes once the active config
 * has any state, to avoid two writers clobbering each other. From the error
 * message: "config base hash required; re-run config.get and retry".
 *
 * We fetch the current snapshot, extract the hash (the field name may be
 * `hash` or `baseHash` depending on Gateway version — handle both), and
 * include it in the patch. After a successful patch the hash changes, so
 * each patch re-fetches.
 */
async function configPatch(
  client: GatewayClient,
  patch: Record<string, unknown>,
): Promise<unknown> {
  const current = await client.rpc<Record<string, unknown>>("config.get", {});
  const hash =
    typeof current["hash"] === "string"
      ? (current["hash"] as string)
      : typeof current["baseHash"] === "string"
        ? (current["baseHash"] as string)
        : undefined;

  return client.rpc("config.patch", {
    raw: JSON.stringify(patch),
    ...(hash ? { baseHash: hash } : {}),
  });
}

/** Helper that logs a step name, runs it, and pretty-prints the result. */
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  process.stdout.write(`\n→ ${name}\n`);
  try {
    const result = await fn();
    const printable = JSON.stringify(result, null, 2);
    // Trim huge payloads so the log stays scannable.
    const trimmed =
      printable.length > 4000
        ? printable.slice(0, 4000) + "\n... (truncated)"
        : printable;
    console.log(`✓ ${trimmed}`);
    return result;
  } catch (err) {
    const e = err as Error & { gatewayError?: unknown };
    console.error(`✗ ${name} failed: ${e.message}`);
    if (e.gatewayError) {
      console.error(
        `  details: ${JSON.stringify(e.gatewayError, null, 2)}`,
      );
    }
    throw err;
  }
}

main().catch((err) => {
  console.error("\n✗ bootstrap failed:", (err as Error).message ?? err);
  process.exit(1);
});
