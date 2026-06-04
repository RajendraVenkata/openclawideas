// ──────────────────────────────────────────────────────────────────────────
// Real origin: openclaw/src/pairing/allow-from-store-file.ts.
// Resolves the per-channel pairing credential paths and reads/writes the
// approved allow-from store ({ version, allowFrom: [...] }).
//
// Real `resolvePairingCredentialsDir` = resolveOAuthDir(resolveStateDir(...)) —
// i.e. under OPENCLAW_STATE_DIR or ~/.openclaw. To avoid writing into a real
// openclaw install, this demo defaults the state dir to a LOCAL .openclaw-state
// folder, while still honoring OPENCLAW_STATE_DIR.
// ──────────────────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import type { AllowFromStore, PairingChannel } from "./pairing-store.types.js";

export type { AllowFromStore };

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENCLAW_STATE_DIR ?? path.join(process.cwd(), ".openclaw-state");
}

export function resolvePairingCredentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "credentials", "pairing");
}

// Sanitize a channel/account id into a safe filename key (real: normalizePairingFilenameKey).
export function safeChannelKey(value: PairingChannel): string {
  const raw = String(value).trim().toLowerCase();
  const safe = raw.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
  if (!safe || safe === "_") {
    throw new Error(`invalid pairing key: got "${String(value)}"`);
  }
  return safe;
}

export function resolveAllowFromFilePath(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId = "default",
): string {
  return path.join(
    resolvePairingCredentialsDir(env),
    `${safeChannelKey(channel)}-${safeChannelKey(accountId)}-allow-from.json`,
  );
}

export function readAllowFromStateForPathSync(filePath: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as AllowFromStore;
    return Array.isArray(parsed.allowFrom) ? parsed.allowFrom.slice() : [];
  } catch {
    return [];
  }
}

export async function readAllowFromStateForPath(filePath: string): Promise<string[]> {
  // (Real uses async fs + a freshness cache; sync read is fine for the demo.)
  return readAllowFromStateForPathSync(filePath);
}
