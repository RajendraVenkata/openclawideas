// ──────────────────────────────────────────────────────────────────────────
// SHIM (type fragments, VERBATIM) — origin: openclaw/src/config/types.gateway.ts
//
// The real file is ~480 LOC describing the whole gateway config surface. Only
// the type fragments touched by startup steps 1–4 are reproduced here, copied
// VERBATIM (same names, same shapes) so the extracted functions type-check
// against the genuine contracts.
// ──────────────────────────────────────────────────────────────────────────

import type { SecretInput } from "./types.secrets.js";

// ── Auth (step 2) ──────────────────────────────────────────────────────────
export type GatewayAuthMode = "none" | "token" | "password" | "trusted-proxy";

export type GatewayTrustedProxyConfig = {
  userHeader: string;
  requiredHeaders?: string[];
  allowUsers?: string[];
  allowLoopback?: boolean;
};

export type GatewayAuthRateLimitConfig = {
  maxAttempts?: number;
  windowMs?: number;
  lockoutMs?: number;
  exemptLoopback?: boolean;
};

export type GatewayAuthConfig = {
  /** Authentication mode for Gateway connections. Defaults to token when unset. */
  mode?: GatewayAuthMode;
  /** Shared token for token mode (plaintext or SecretRef). */
  token?: SecretInput;
  /** Shared password for password mode (consider env instead). */
  password?: SecretInput;
  /** Allow Tailscale identity headers when serve mode is enabled. */
  allowTailscale?: boolean;
  /** Rate-limit configuration for failed authentication attempts. */
  rateLimit?: GatewayAuthRateLimitConfig;
  /** Configuration for trusted-proxy auth mode. Required when mode is "trusted-proxy". */
  trustedProxy?: GatewayTrustedProxyConfig;
};

export type GatewayTailscaleMode = "off" | "serve" | "funnel";

// ── Reload (step 3) ────────────────────────────────────────────────────────
export type GatewayReloadMode = "off" | "restart" | "hot" | "hybrid";

export type GatewayReloadConfig = {
  mode?: GatewayReloadMode;
  debounceMs?: number;
};

// ── Bind / port (step 1 + 4) ───────────────────────────────────────────────
export type GatewayBindMode = "auto" | "lan" | "loopback" | "custom" | "tailnet";

export type GatewayConfig = {
  /** Single multiplexed port for Gateway WS + HTTP (default: 18789). */
  port?: number;
  /** Network bind profile controlling interface exposure. */
  bind?: GatewayBindMode;
  customBindHost?: string;
  auth?: GatewayAuthConfig;
  reload?: GatewayReloadConfig;
  tailscale?: { mode?: GatewayTailscaleMode };
};
