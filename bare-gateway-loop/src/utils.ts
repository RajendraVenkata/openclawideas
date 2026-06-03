// VERBATIM — origin: openclaw/src/utils.ts (line ~59)
export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
