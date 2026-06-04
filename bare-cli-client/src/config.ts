// Persisted CLI config: ~/.bare-cli/config.json. Stores name + token + gateway
// address, so subsequent launches don't re-ask. `/reset` deletes it.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type CliConfig = {
  name: string;
  token: string;
  host: string;
  port: number;
};

const CONFIG_DIR = path.join(os.homedir(), ".bare-cli");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

export async function loadConfig(): Promise<CliConfig | null> {
  try {
    return JSON.parse(await fs.readFile(CONFIG_PATH, "utf8")) as CliConfig;
  } catch {
    return null;
  }
}

export async function saveConfig(cfg: CliConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

export async function resetConfig(): Promise<void> {
  try {
    await fs.rm(CONFIG_PATH);
  } catch {
    /* nothing to delete */
  }
}
