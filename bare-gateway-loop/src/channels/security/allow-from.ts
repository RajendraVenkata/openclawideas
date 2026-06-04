// ──────────────────────────────────────────────────────────────────────────
// Inbound sender authorization — faithful to openclaw/src/channels/allow-from.ts.
// `isSenderIdAllowed` is copied VERBATIM; `mergeDmAllowFromSources` mirrors the
// real merge (config allowFrom + the approved pairing store, except for the
// "allowlist"/"open" policies which ignore the store).
// ──────────────────────────────────────────────────────────────────────────

// Real origin: openclaw/src/config/types.base.ts
export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";

export type CompiledAllow = { entries: string[]; hasWildcard: boolean; hasEntries: boolean };

function normalizeStringEntries(entries: ReadonlyArray<string | number>): string[] {
  return entries.map((e) => String(e).trim()).filter((e) => e.length > 0);
}

export function compileAllow(entries: ReadonlyArray<string | number>): CompiledAllow {
  const normalized = normalizeStringEntries(entries);
  return {
    entries: normalized.filter((e) => e !== "*"),
    hasWildcard: normalized.includes("*"),
    hasEntries: normalized.length > 0,
  };
}

// VERBATIM from openclaw/src/channels/allow-from.ts
export function isSenderIdAllowed(
  allow: { entries: string[]; hasWildcard: boolean; hasEntries: boolean },
  senderId: string | undefined,
  allowWhenEmpty: boolean,
): boolean {
  if (!allow.hasEntries) {
    return allowWhenEmpty;
  }
  if (allow.hasWildcard) {
    return true;
  }
  if (!senderId) {
    return false;
  }
  return allow.entries.includes(senderId);
}

// Faithful from openclaw/src/channels/allow-from.ts: combine config allowFrom
// with the pairing store's approved entries — but "allowlist"/"open" ignore the
// store (they're driven purely by config).
export function mergeDmAllowFromSources(params: {
  allowFrom?: Array<string | number>;
  storeAllowFrom?: Array<string | number>;
  dmPolicy?: string;
}): string[] {
  const storeEntries =
    params.dmPolicy === "allowlist" || params.dmPolicy === "open"
      ? []
      : (params.storeAllowFrom ?? []);
  return normalizeStringEntries([...(params.allowFrom ?? []), ...storeEntries]);
}
