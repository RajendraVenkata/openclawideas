// ──────────────────────────────────────────────────────────────────────────
// Real origin: openclaw/src/pairing/pairing-store.ts.
// The PERSISTENT pairing store: pending requests in <channel>-pairing.json, and
// the approved allow-from list in a separate file. Approving a code moves the
// sender from a pending request into the persisted allow-from store, so it
// survives restarts.
//
// Faithful subset: same function names + signatures + two-file model. Real adds
// file locks, a freshness cache, request pruning/expiry, account scoping, and
// legacy-store compat — trimmed here.
// ──────────────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";
import path from "node:path";
import type { PairingChannel, PairingRequest, PairingStore } from "./pairing-store.types.js";
import {
  readAllowFromStateForPath,
  readAllowFromStateForPathSync,
  resolveAllowFromFilePath,
  resolvePairingCredentialsDir,
  safeChannelKey,
} from "./allow-from-store-file.js";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "./json-file.js";
import type { AllowFromStore } from "./pairing-store.types.js";

const DEFAULT_ACCOUNT_ID = "default";

function resolvePairingPath(channel: PairingChannel, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolvePairingCredentialsDir(env), `${safeChannelKey(channel)}-pairing.json`);
}

export function resolveChannelAllowFromPath(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId = DEFAULT_ACCOUNT_ID,
): string {
  return resolveAllowFromFilePath(channel, env, accountId);
}

// ── pending requests ────────────────────────────────────────────────────────
async function readPairingRequests(filePath: string): Promise<PairingRequest[]> {
  const { value } = await readJsonFileWithFallback<PairingStore>(filePath, {
    version: 1,
    requests: [],
  });
  return Array.isArray(value.requests) ? value.requests : [];
}

async function writePairingRequests(filePath: string, requests: PairingRequest[]): Promise<void> {
  await writeJsonFileAtomically(filePath, { version: 1, requests } satisfies PairingStore);
}

function accountIdOf(request: PairingRequest): string {
  return request.meta?.accountId ?? DEFAULT_ACCOUNT_ID;
}

function generatePairingCode(): string {
  return randomBytes(3).toString("hex").toUpperCase(); // 6 hex chars
}

// ── approved allow-from store ───────────────────────────────────────────────
export async function readChannelAllowFromStore(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId = DEFAULT_ACCOUNT_ID,
): Promise<string[]> {
  return readAllowFromStateForPath(resolveAllowFromFilePath(channel, env, accountId));
}

export function readChannelAllowFromStoreSync(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId = DEFAULT_ACCOUNT_ID,
): string[] {
  return readAllowFromStateForPathSync(resolveAllowFromFilePath(channel, env, accountId));
}

async function writeAllowFrom(filePath: string, allowFrom: string[]): Promise<void> {
  await writeJsonFileAtomically(filePath, { version: 1, allowFrom } satisfies AllowFromStore);
}

export async function addChannelAllowFromStoreEntry(params: {
  channel: PairingChannel;
  entry: string;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changed: boolean; allowFrom: string[] }> {
  const env = params.env ?? process.env;
  const filePath = resolveAllowFromFilePath(params.channel, env, params.accountId ?? DEFAULT_ACCOUNT_ID);
  const current = await readAllowFromStateForPath(filePath);
  const normalized = String(params.entry).trim();
  if (!normalized || current.includes(normalized)) {
    return { changed: false, allowFrom: current };
  }
  const next = [...current, normalized];
  await writeAllowFrom(filePath, next);
  return { changed: true, allowFrom: next };
}

export async function removeChannelAllowFromStoreEntry(params: {
  channel: PairingChannel;
  entry: string;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changed: boolean; allowFrom: string[] }> {
  const env = params.env ?? process.env;
  const filePath = resolveAllowFromFilePath(params.channel, env, params.accountId ?? DEFAULT_ACCOUNT_ID);
  const current = await readAllowFromStateForPath(filePath);
  const normalized = String(params.entry).trim();
  const next = current.filter((entry) => entry !== normalized);
  if (next.length === current.length) {
    return { changed: false, allowFrom: current };
  }
  await writeAllowFrom(filePath, next);
  return { changed: true, allowFrom: next };
}

// ── request lifecycle ───────────────────────────────────────────────────────
export async function listChannelPairingRequests(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId = DEFAULT_ACCOUNT_ID,
): Promise<PairingRequest[]> {
  const requests = await readPairingRequests(resolvePairingPath(channel, env));
  return requests
    .filter((r) => accountIdOf(r) === accountId)
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function upsertChannelPairingRequest(params: {
  channel: PairingChannel;
  id: string | number;
  accountId: string;
  meta?: Record<string, string | undefined | null>;
  env?: NodeJS.ProcessEnv;
}): Promise<{ code: string; created: boolean }> {
  const env = params.env ?? process.env;
  const filePath = resolvePairingPath(params.channel, env);
  const requests = await readPairingRequests(filePath);
  const id = String(params.id);
  const now = new Date().toISOString();

  const existing = requests.find((r) => r.id === id && accountIdOf(r) === params.accountId);
  if (existing) {
    existing.lastSeenAt = now;
    await writePairingRequests(filePath, requests);
    return { code: existing.code, created: false };
  }

  const meta: Record<string, string> = { accountId: params.accountId };
  for (const [key, value] of Object.entries(params.meta ?? {})) {
    if (typeof value === "string") {
      meta[key] = value;
    }
  }
  const code = generatePairingCode();
  requests.push({ id, code, createdAt: now, lastSeenAt: now, meta });
  await writePairingRequests(filePath, requests);
  return { code, created: true };
}

export async function approveChannelPairingCode(params: {
  channel: PairingChannel;
  code: string;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ id: string; entry?: PairingRequest } | null> {
  const env = params.env ?? process.env;
  const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
  const code = (params.code ?? "").trim().toUpperCase();
  if (!code) {
    return null;
  }
  const filePath = resolvePairingPath(params.channel, env);
  const requests = await readPairingRequests(filePath);
  const idx = requests.findIndex(
    (r) => r.code.toUpperCase() === code && accountIdOf(r) === accountId,
  );
  if (idx < 0) {
    return null;
  }
  const entry = requests[idx];
  requests.splice(idx, 1);
  await writePairingRequests(filePath, requests);
  // Persist the approved sender into the allow-from store (survives restarts).
  await addChannelAllowFromStoreEntry({ channel: params.channel, entry: entry.id, accountId, env });
  return { id: entry.id, entry };
}
