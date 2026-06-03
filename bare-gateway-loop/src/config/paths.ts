// ──────────────────────────────────────────────────────────────────────────
// VERBATIM extract — origin: openclaw/src/config/paths.ts (lines ~262, 302–349)
//
// STEP 1: port resolution. Precedence (exactly as in the real gateway):
//   OPENCLAW_GATEWAY_PORT  →  cfg.gateway.port  →  DEFAULT_GATEWAY_PORT (18789)
//
// The bodies below are copied unchanged from the real module. The real file
// also resolves many other paths (state dir, workspace, sockets, …); only the
// port logic is reproduced here.
// ──────────────────────────────────────────────────────────────────────────

import type { OpenClawConfig } from "./types.openclaw.js";

export const DEFAULT_GATEWAY_PORT = 18789;

function parseGatewayPortEnvValue(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  // Docker Compose publish strings can leak into host CLI env loading via repo `.env`,
  // for example `127.0.0.1:18789` or `[::1]:18789`. Accept only explicit host:port forms.
  const bracketedIpv6Match = trimmed.match(/^\[[^\]]+\]:(\d+)$/);
  if (bracketedIpv6Match?.[1]) {
    const parsed = Number.parseInt(bracketedIpv6Match[1], 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  const firstColon = trimmed.indexOf(":");
  const lastColon = trimmed.lastIndexOf(":");
  if (firstColon <= 0 || firstColon !== lastColon) {
    return null;
  }
  const suffix = trimmed.slice(firstColon + 1);
  if (!/^\d+$/.test(suffix)) {
    return null;
  }
  const parsed = Number.parseInt(suffix, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveGatewayPort(
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const envRaw = env.OPENCLAW_GATEWAY_PORT?.trim();
  const envPort = parseGatewayPortEnvValue(envRaw);
  if (envPort !== null) {
    return envPort;
  }
  const configPort = cfg?.gateway?.port;
  if (typeof configPort === "number" && Number.isFinite(configPort)) {
    if (configPort > 0) {
      return configPort;
    }
  }
  return DEFAULT_GATEWAY_PORT;
}

// ── Bind host (step 4 helper) ──────────────────────────────────────────────
// The real gateway resolves bind hosts via gateway.bind profiles
// ("loopback" → 127.0.0.1, "lan" → host LAN IP, "custom" → customBindHost, …)
// in src/gateway/server-runtime-state.ts (resolveGatewayListenHosts) and
// src/config/validation.ts. This is the loopback-default slice of that logic.
export function resolveGatewayBindHost(cfg?: OpenClawConfig): string {
  const bind = cfg?.gateway?.bind ?? "loopback";
  if (bind === "custom" && cfg?.gateway?.customBindHost) {
    return cfg.gateway.customBindHost;
  }
  if (bind === "lan" || bind === "auto") {
    return "0.0.0.0";
  }
  // "loopback" (default) and "tailnet" fall back to loopback for the bare loop.
  return "127.0.0.1";
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
