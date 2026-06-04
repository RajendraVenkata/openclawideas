// Small JSON file helpers (real origin: openclaw infra — readJsonFileWithFallback,
// writeJsonFileAtomically). Atomic write = write tmp then rename.
import fs from "node:fs/promises";
import path from "node:path";

export async function readJsonFileWithFallback<T>(
  filePath: string,
  fallback: T,
): Promise<{ value: T; exists: boolean }> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return { value: JSON.parse(raw) as T, exists: true };
  } catch {
    return { value: fallback, exists: false };
  }
}

export async function writeJsonFileAtomically(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}
