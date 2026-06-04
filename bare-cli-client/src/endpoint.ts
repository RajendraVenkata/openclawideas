// Gateway endpoint parsing + override resolution.
// Default: 127.0.0.1:18789. Accepts host:port, host (default port), [ipv6]:port,
// and ws://… / http://… forms.

export type Endpoint = { host: string; port: number };

export const DEFAULT_ENDPOINT: Endpoint = { host: "127.0.0.1", port: 18789 };

export function parseEndpoint(input: string | undefined, fallback: Endpoint = DEFAULT_ENDPOINT): Endpoint {
  const raw = (input ?? "")
    .trim()
    .replace(/^wss?:\/\//i, "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  if (!raw) {
    return { ...fallback };
  }
  const ipv6 = raw.match(/^\[([^\]]+)\]:(\d+)$/);
  if (ipv6) {
    return { host: ipv6[1], port: Number(ipv6[2]) };
  }
  const hostPort = raw.match(/^([^:]+):(\d+)$/);
  if (hostPort) {
    return { host: hostPort[1], port: Number(hostPort[2]) };
  }
  return { host: raw, port: fallback.port };
}

// Endpoint override from `--gateway <ep>` / `--gateway=<ep>` / `-g <ep>` or the
// BARE_CLI_GATEWAY env var. Returns undefined if none given.
export function endpointOverride(
  argv: string[],
  env: NodeJS.ProcessEnv,
): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === "--gateway" || arg === "-g") && argv[i + 1]) {
      return argv[i + 1];
    }
    const eq = arg.match(/^--gateway=(.+)$/);
    if (eq) {
      return eq[1];
    }
  }
  return env.BARE_CLI_GATEWAY;
}
