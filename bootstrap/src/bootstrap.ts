/**
 * End-to-end Gateway configuration over WebSocket — SDK version.
 *
 *   $ ./run-in-sidecar.sh bootstrap
 *
 * Uses @openclaw/sdk (file: dep from the local openclaw monorepo) for
 * namespaced calls, and the raw GatewayClientTransport for surfaces the
 * SDK doesn't wrap yet (config.*, channels.*).
 *
 * What it does (each step is idempotent and gated by env vars — set only
 * what you want to configure):
 *
 *   1. Connect + verify SDK transport.
 *   2. Read current models / channels / agents (snapshot of state-before).
 *   3. Apply default workspace + model + provider key
 *      (if OPENAI_API_KEY or ANTHROPIC_API_KEY is set).
 *   4. Register the Telegram channel
 *      (if TELEGRAM_BOT_TOKEN and TELEGRAM_USER_ID are set).
 *   5. Start the Telegram channel.
 *   6. Verify final status with a live channel probe.
 *
 * Architecture:
 *   - oc.models.*    via SDK ModelsNamespace
 *   - oc.agents.*    via SDK AgentsNamespace
 *   - transport.request("config.*")    raw escape hatch (no SDK wrapper)
 *   - transport.request("channels.*")  raw escape hatch
 *
 * Key correctness notes:
 *   - ConfigPatchParams.raw is a STRING (JSON5 text), NOT an object. Always
 *     pass JSON.stringify(...).
 *   - config.patch requires baseHash (optimistic concurrency). The
 *     configPatch() helper handles fetch-current-hash-then-patch.
 *   - models.providers.<id>.baseUrl is validated as required non-empty.
 */

import { GatewayClientTransport, OpenClaw } from "@openclaw/sdk";

const WORKSPACE_PATH = "/home/node/.openclaw/workspace";

function readEnv(): { url: string; token: string } {
  const url = process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18789";
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) {
    throw new Error(
      "OPENCLAW_GATEWAY_TOKEN is not set. Export it or put it in .env.",
    );
  }
  return { url, token };
}

async function main(): Promise<void> {
  const { url, token } = readEnv();

  // We construct the transport ourselves so we can use it for raw RPCs
  // alongside the SDK's typed namespaces.
  const transport = new GatewayClientTransport({ url, token });
  const oc = new OpenClaw({ transport });

  console.log(`→ connecting to ${url}`);
  await oc.connect();
  console.log("✓ connected via @openclaw/sdk");

  // === Snapshot state-before ===
  await step("models.list (state-before)", async () =>
    oc.models.list({ view: "configured" }),
  );

  await step("channels.status (state-before)", async () =>
    transport.request("channels.status", {}),
  );

  await step("agents.list (state-before)", async () => oc.agents.list());

  // === Provider key + default model ===
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

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
        // Use || (not ??) so an empty-string env value falls back too.
        // The sidecar wrapper passes -e OPENAI_BASE_URL="${OPENAI_BASE_URL:-}",
        // which means an unset host var arrives as "" inside the container.
        baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      };
    }
    if (anthropicKey) {
      providers["anthropic"] = {
        apiKey: anthropicKey,
        baseUrl:
          process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
      };
    }

    const configured = Object.keys(providers).join(" + ");

    await step(`config.patch — ${configured} provider + default model`, async () =>
      configPatch(transport, {
        models: { providers },
        agents: {
          defaults: {
            workspace: WORKSPACE_PATH,
            model: defaultModel,
          },
        },
        session: { dmScope: "per-channel-peer" },
      }),
    );

    await step("models.list (configured)", async () =>
      oc.models.list({ view: "configured" }),
    );

    await step("models.status", async () => oc.models.status({}));
  } else {
    console.log(
      "⊘ skipping model setup — set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env",
    );
  }

  // === Telegram channel ===
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramUserId = process.env.TELEGRAM_USER_ID;

  if (telegramToken && telegramUserId) {
    await step("config.patch — Telegram channel", async () =>
      configPatch(transport, {
        channels: {
          telegram: {
            enabled: true,
            botToken: telegramToken,
            dmPolicy: "allowlist",
            allowFrom: [telegramUserId],
            groupPolicy: "allowlist",
          },
        },
      }),
    );

    await step("channels.start telegram", async () =>
      transport.request("channels.start", { channel: "telegram" }),
    );

    await step("channels.status telegram (probed)", async () =>
      transport.request("channels.status", {
        channel: "telegram",
        probe: true,
        timeoutMs: 8000,
      }),
    );
  } else {
    console.log(
      "⊘ skipping Telegram setup — set TELEGRAM_BOT_TOKEN and TELEGRAM_USER_ID in .env",
    );
  }

  // === Final snapshot ===
  await step("channels.status (final)", async () =>
    transport.request("channels.status", { probe: true, timeoutMs: 8000 }),
  );

  await step("agents.list (final)", async () => oc.agents.list());

  console.log("\n✓ bootstrap complete");
  await oc.close();
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
 *
 * This lives outside the SDK because @openclaw/sdk has no `config`
 * namespace yet. When it adds one, replace these two transport.request
 * calls with `oc.config.patch({...})`.
 */
async function configPatch(
  transport: GatewayClientTransport,
  patch: Record<string, unknown>,
): Promise<unknown> {
  const current = (await transport.request("config.get", {})) as Record<
    string,
    unknown
  >;
  const hash =
    typeof current["hash"] === "string"
      ? (current["hash"] as string)
      : typeof current["baseHash"] === "string"
        ? (current["baseHash"] as string)
        : undefined;

  return transport.request("config.patch", {
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
      console.error(`  details: ${JSON.stringify(e.gatewayError, null, 2)}`);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error("\n✗ bootstrap failed:", (err as Error).message ?? err);
  process.exit(1);
});
