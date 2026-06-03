// ──────────────────────────────────────────────────────────────────────────
// SHIM (minimal, faithful) — origin: openclaw/src/config/types.secrets.ts
//
// The real module implements full "SecretRef" resolution (env:/file:/exec:
// secret providers, legacy markers, env templates). That whole subsystem is
// out of scope for the bare startup loop. The two helpers below keep the EXACT
// real signatures and the real behaviour for the common case the bare loop
// exercises: a plain inline string token/password (NOT a SecretRef).
//
// Real behaviour preserved:
//   • resolveSecretInputRef(plain string) -> { ref: null }   (no SecretRef)
//   • hasConfiguredSecretInput(non-empty string) -> true
// Full SecretRef parsing/coercion lives in the real file (~600 LOC).
// ──────────────────────────────────────────────────────────────────────────

export type SecretRef = {
  source: "env" | "file" | "exec";
  provider: string;
  id: string;
};

/** A config value that is either an inline secret string or a SecretRef. */
export type SecretInput = string | SecretRef;

export type SecretDefaults = {
  env?: string;
  file?: string;
  exec?: string;
};

// Verbatim from the real module.
export function normalizeSecretInputString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Minimal faithful coercion: the bare loop only uses inline string secrets,
// which the real coerceSecretRef() also treats as "not a SecretRef" (returns
// null) unless they match a SecretRef shape/marker. Objects are passed through
// as already-structured SecretRefs.
function coerceSecretRef(value: unknown, _defaults?: SecretDefaults): SecretRef | null {
  if (value && typeof value === "object" && "source" in value && "id" in value) {
    return value as SecretRef;
  }
  return null;
}

// Verbatim signature/shape from the real module.
export function resolveSecretInputRef(params: {
  value: unknown;
  refValue?: unknown;
  defaults?: SecretDefaults;
}): {
  explicitRef: SecretRef | null;
  inlineRef: SecretRef | null;
  ref: SecretRef | null;
} {
  const explicitRef = coerceSecretRef(params.refValue, params.defaults);
  const inlineRef = explicitRef ? null : coerceSecretRef(params.value, params.defaults);
  return {
    explicitRef,
    inlineRef,
    ref: explicitRef ?? inlineRef,
  };
}

// Verbatim from the real module.
export function hasConfiguredSecretInput(value: unknown, defaults?: SecretDefaults): boolean {
  if (normalizeSecretInputString(value)) {
    return true;
  }
  return coerceSecretRef(value, defaults) !== null;
}
