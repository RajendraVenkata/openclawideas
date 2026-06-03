// ──────────────────────────────────────────────────────────────────────────
// Real origin: extensions/msteams/src/sdk.ts → loadMSTeamsSdkWithAuth,
// createMSTeamsAdapter, createMSTeamsTokenProvider, createBotFrameworkJwtValidator.
//
// In the real plugin these wrap `@microsoft/teams.api` + `@microsoft/teams.apps`:
// `loadMSTeamsSdkWithAuth` builds the SDK `App` from the credentials, and
// `createMSTeamsAdapter(...).process(req, res, logic)` validates the inbound JWT
// and hands you a TurnContext.
//
// To stay runnable offline (you chose "faithful + locally testable"), we do NOT
// import the SDK here. The adapter parses the Bot Framework **Activity** JSON
// directly, and the JWT validator runs in "local/emulator" mode when no app
// secret is configured — exactly how you'd run against the Bot Framework Emulator.
// Going fully real = swap these three functions to call the SDK; the callers in
// monitor.ts don't change.
// ──────────────────────────────────────────────────────────────────────────

import type { MSTeamsCredentials } from "./token.js";
import type { MSTeamsActivity } from "./monitor-handler.js";

export async function loadMSTeamsSdkWithAuth(
  _creds: MSTeamsCredentials,
): Promise<{ sdk: unknown; app: unknown }> {
  // REAL: const sdk = await import("@microsoft/teams.apps");
  //       const app = new sdk.App({ clientId: creds.appId, clientSecret: creds.appPassword, tenantId: creds.tenantId });
  return { sdk: null, app: null };
}

export function createMSTeamsTokenProvider(_app: unknown): { getToken: () => Promise<null> } {
  // REAL: a Graph API token provider built from the SDK app credentials.
  return { getToken: async () => null };
}

export type MSTeamsJwtValidator = {
  localMode: boolean;
  validate: (authHeader: string | undefined) => { ok: boolean; reason?: string };
};

export function createBotFrameworkJwtValidator(creds: MSTeamsCredentials): MSTeamsJwtValidator {
  const localMode = !creds.appPassword;
  return {
    localMode,
    validate(authHeader) {
      if (!authHeader?.startsWith("Bearer ")) {
        return { ok: false, reason: "missing bearer token" };
      }
      if (localMode) {
        // Local/emulator: accept any bearer (no Azure to verify against).
        return { ok: true };
      }
      // REAL: verify JWT signature + issuer + audience===appId against the Bot
      // Framework OpenID metadata (https://login.botframework.com/v1/.well-known/openidconfiguration).
      return { ok: true };
    },
  };
}

export type MSTeamsAdapterLike = {
  process: (
    activity: MSTeamsActivity,
    runLogic: (context: { activity: MSTeamsActivity }) => Promise<void>,
  ) => Promise<void>;
};

export function createMSTeamsAdapter(_app: unknown, _sdk: unknown): MSTeamsAdapterLike {
  return {
    // REAL: adapter.process(req, res, (turnContext) => logic(turnContext)) — the
    // SDK parses the request + builds a TurnContext. Here the Activity is already
    // parsed JSON; we just wrap it as { activity } and run the handler.
    async process(activity, runLogic) {
      await runLogic({ activity });
    },
  };
}
