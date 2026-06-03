// ──────────────────────────────────────────────────────────────────────────
// CONDENSED (faithful shape) — origin: openclaw/src/gateway/config-reload.ts
//   real entry point: startGatewayConfigReloader() (~420 LOC)
//
// STEP 3 (the watcher): the real reloader uses `chokidar` to watch the config
// file (+ included files), debounces by settings.debounceMs, then either
// hot-swaps the in-memory snapshot ("hot"), restarts ("restart"), or decides
// per-change ("hybrid"). It is intentionally large (plugin reload targets,
// skills-snapshot invalidation, channel reload planning, …).
//
// This condensed version keeps the REAL public shape — startGatewayConfigReloader({
// watchPath, settings, loadConfig, onConfig }) returning a stop() handle — and
// the REAL debounce-timer mechanic, but uses Node's built-in fs.watch instead of
// chokidar and drops the downstream reload-planning. It calls the VERBATIM
// resolveGatewayReloadSettings() output via the `settings` it is handed.
// ──────────────────────────────────────────────────────────────────────────

import { watch as fsWatch, type FSWatcher } from "node:fs";
import type { GatewayReloadSettings } from "./config-reload-settings.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type GatewayConfigReloaderHandle = {
  stop(): Promise<void>;
};

export function startGatewayConfigReloader(opts: {
  watchPath: string;
  settings: GatewayReloadSettings;
  loadConfig: () => Promise<OpenClawConfig>;
  onConfig: (cfg: OpenClawConfig, settings: GatewayReloadSettings) => void;
}): GatewayConfigReloaderHandle {
  const { watchPath, settings } = opts;

  if (settings.mode === "off") {
    return { stop: async () => {} };
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  let stopped = false;

  const scheduleAfter = (ms: number) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void reload();
    }, ms);
  };

  const reload = async () => {
    if (stopped) {
      return;
    }
    try {
      const cfg = await opts.loadConfig();
      // Real reloader branches on settings.mode here: "hot" swaps the in-memory
      // snapshot live, "restart" tears down + re-execs, "hybrid" chooses per the
      // changed keys (some changes are hot-swappable, some require a restart).
      opts.onConfig(cfg, settings);
    } catch (err) {
      console.error(`[gateway/config-reload] reload failed: ${String(err)}`);
    }
  };

  watcher = fsWatch(watchPath, () => scheduleAfter(settings.debounceMs));

  return {
    stop: async () => {
      stopped = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      watcher?.close();
      watcher = null;
    },
  };
}
