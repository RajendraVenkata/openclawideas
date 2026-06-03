// ──────────────────────────────────────────────────────────────────────────
// VERBATIM core — origin: openclaw/src/gateway/credentials.ts
//
// STEP 2 (credential selection): resolve the effective token/password from
// config vs environment, honouring precedence. resolveGatewayCredentialsFromValues
// is copied VERBATIM. The two trim helpers it depends on come from
// src/gateway/credential-planner.ts and are reproduced faithfully below
// (trimToUndefined === normalizeOptionalString; trimCredentialToUndefined also
// rejects literal ${ENV_VAR} placeholders).
// ──────────────────────────────────────────────────────────────────────────

export type GatewayCredentialPrecedence = "env-first" | "config-first";

type ResolvedGatewayCredentials = {
  token?: string;
  password?: string;
};

// ── trim helpers (faithful) — origin: src/gateway/credential-planner.ts ──────
export function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function containsEnvVarReference(value: string): boolean {
  // Matches unresolved shell-style placeholders like ${OPENCLAW_GATEWAY_TOKEN}.
  return /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value);
}

/**
 * Like trimToUndefined but also rejects unresolved env var placeholders (e.g. `${VAR}`).
 * This prevents literal placeholder strings like `${OPENCLAW_GATEWAY_TOKEN}` from being
 * accepted as valid credentials when the referenced env var is missing.
 */
export function trimCredentialToUndefined(value: unknown): string | undefined {
  const trimmed = trimToUndefined(value);
  if (trimmed && containsEnvVarReference(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function firstDefined(values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return undefined;
}

// ── VERBATIM from src/gateway/credentials.ts (lines ~74–104) ─────────────────
export function resolveGatewayCredentialsFromValues(params: {
  configToken?: unknown;
  configPassword?: unknown;
  env?: NodeJS.ProcessEnv;
  tokenPrecedence?: GatewayCredentialPrecedence;
  passwordPrecedence?: GatewayCredentialPrecedence;
}): ResolvedGatewayCredentials {
  const env = params.env ?? process.env;
  const envToken = trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN);
  const envPassword = trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD);
  const configToken = trimCredentialToUndefined(params.configToken);
  const configPassword = trimCredentialToUndefined(params.configPassword);
  const tokenPrecedence = params.tokenPrecedence ?? "env-first";
  const passwordPrecedence = params.passwordPrecedence ?? "env-first";

  const token =
    tokenPrecedence === "config-first"
      ? firstDefined([configToken, envToken])
      : firstDefined([envToken, configToken]);
  const password =
    passwordPrecedence === "config-first" // pragma: allowlist secret
      ? firstDefined([configPassword, envPassword])
      : firstDefined([envPassword, configPassword]);

  return { token, password };
}
