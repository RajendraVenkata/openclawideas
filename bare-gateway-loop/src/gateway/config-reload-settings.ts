// ──────────────────────────────────────────────────────────────────────────
// VERBATIM — origin: openclaw/src/gateway/config-reload-settings.ts (whole file)
//
// STEP 3 (hot-reload settings): resolve gateway.reload into { mode, debounceMs }.
// Defaults: mode "hybrid", debounceMs 300. Valid modes: off | restart | hot | hybrid.
// ──────────────────────────────────────────────────────────────────────────

import type { GatewayReloadMode } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type GatewayReloadSettings = {
  mode: GatewayReloadMode;
  debounceMs: number;
};

const DEFAULT_RELOAD_SETTINGS: GatewayReloadSettings = {
  mode: "hybrid",
  debounceMs: 300,
};

export function resolveGatewayReloadSettings(cfg: OpenClawConfig): GatewayReloadSettings {
  const rawMode = cfg.gateway?.reload?.mode;
  const mode =
    rawMode === "off" || rawMode === "restart" || rawMode === "hot" || rawMode === "hybrid"
      ? rawMode
      : DEFAULT_RELOAD_SETTINGS.mode;
  const debounceRaw = cfg.gateway?.reload?.debounceMs;
  const debounceMs =
    typeof debounceRaw === "number" && Number.isFinite(debounceRaw)
      ? Math.max(0, Math.floor(debounceRaw))
      : DEFAULT_RELOAD_SETTINGS.debounceMs;
  return { mode, debounceMs };
}
