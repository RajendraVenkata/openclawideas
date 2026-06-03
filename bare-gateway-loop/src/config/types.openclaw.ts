// ──────────────────────────────────────────────────────────────────────────
// SHIM (minimal) — origin: openclaw/src/config/types.openclaw.ts
//
// The real OpenClawConfig is the root config type (hundreds of fields across
// agents, channels, plugins, tools, secrets, gateway, …). The bare startup loop
// only reads `gateway` and `secrets.defaults`, so this shim carries just those.
// ──────────────────────────────────────────────────────────────────────────

import type { GatewayConfig } from "./types.gateway.js";
import type { SecretDefaults } from "./types.secrets.js";

export type OpenClawConfig = {
  gateway?: GatewayConfig;
  secrets?: {
    defaults?: SecretDefaults;
  };
};
