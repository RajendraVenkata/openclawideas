# Known Issues & Workarounds

Issues encountered while working with OpenClaw, with diagnosis and resolution paths. Most recent first.

---

## Issue #1 — Docker build fails at `runtime-assets` with pnpm store-add timeout

**Date:** 2026-05-30
**Severity:** Build-blocking
**Status:** Workarounds available; not a code bug — network/timeout sensitivity

### Symptom

`docker build` fails at **Dockerfile line 126** (the `runtime-assets` stage) with:

```
287.0 TimeoutError: The operation was aborted due to timeout
287.0     at new DOMException (node:internal/per_context/domexception:76:18)
287.0     at Timeout._onTimeout (node:internal/abort_controller:154:9)
287.0     at listOnTimeout (node:internal/timers:605:17)
287.0     at process.processTimers (node:internal/timers:541:7)
287.1 [ERR_PNPM_STORE_ADD_FAILURE] Some packages have not been added correctly
------
Dockerfile:126
--------------------
 125 |     # installed prod graph in the same step that runs offline prune.
 126 | >>> RUN --mount=type=cache,id=openclaw-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
 127 | >>>     pnpm list --prod --depth Infinity --json | node scripts/list-prod-store-packages.mjs | xargs -r pnpm store add && \
 128 | >>>     CI=true pnpm prune --prod \
...
ERROR: failed to build: failed to solve: process "/bin/sh -c pnpm list --prod ..." did not complete successfully
```

Typically preceded by `[WARN]` retry messages during the earlier `build` stage on the `@zed-industries/codex-acp-*` family of platform-specific binary packages:

```
[WARN] GET https://registry.npmjs.org/@zed-industries/codex-acp-linux-x64/-/codex-acp-linux-x64-0.15.0.tgz error (23). Will retry in 10 seconds. 2 retries left.
[WARN] GET https://registry.npmjs.org/@zed-industries/codex-acp-win32-arm64/-/codex-acp-win32-arm64-0.15.0.tgz error (23). Will retry in 10 seconds. 2 retries left.
```

### Reproduction

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
DOCKER_BUILDKIT=1 docker build -t openclaw:local .
```

### Root cause

This is **not** a code defect. It's a network / timeout sensitivity in the Dockerfile's `runtime-assets` stage.

The Dockerfile comment above line 126 explains the design:

> *"BuildKit cache mounts are not part of cached layers; seed tarballs for the installed prod graph in the same step that runs offline prune."*

What happens:

1. The earlier `build` stage's `pnpm install` succeeds — possibly after retries on optional platform-specific packages like `@zed-industries/codex-acp-win32-*` (which are noise on Linux but pnpm still tries to fetch them).
2. The `runtime-assets` stage needs to re-populate the pnpm content-addressable store with fresh tarballs so the subsequent `pnpm prune --prod --config.offline=true` step can run with no network.
3. `pnpm list --prod ... | xargs -r pnpm store add` triggers fresh downloads from `registry.npmjs.org`.
4. On slow / lossy / high-latency connections, downloads exceed pnpm's default `fetch-timeout` (60 s).
5. Failure here is **fatal** (unlike the earlier WARN-level retries in the `build` stage where most failures land on optional platform binaries).

OpenClaw's `extensions/acpx/package.json` depends on `@zed-industries/codex-acp@0.15.0`, which has several platform-specific binary subpackages as optional deps. The Linux variant is the only one actually required for a Linux container; the others (`win32-*`, `darwin-*`) are downloaded by default but unused.

### Fix priority (try in this order)

#### 1. Increase pnpm timeouts via `.npmrc` — recommended primary fix

Create or augment `.npmrc` at the repo root **before** building. The Dockerfile already copies it in (`COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./`), so it applies to all build stages.

```bash
cat >> .npmrc <<'EOF'
fetch-timeout=300000
fetch-retries=5
fetch-retry-mintimeout=10000
fetch-retry-maxtimeout=60000
network-concurrency=4
EOF
```

PowerShell equivalent:
```powershell
@"
fetch-timeout=300000
fetch-retries=5
fetch-retry-mintimeout=10000
fetch-retry-maxtimeout=60000
network-concurrency=4
"@ | Add-Content -Path .npmrc -Encoding ASCII
```

What each does:
- `fetch-timeout=300000` — 5-minute timeout per download (vs default 60 s). **Direct fix for the `TimeoutError`.**
- `fetch-retries=5` — try each tarball up to 5 times.
- `fetch-retry-mintimeout=10000` / `maxtimeout=60000` — exponential back-off bounds.
- `network-concurrency=4` — fewer parallel fetches reduce pressure on a flaky connection.

Then rebuild. The BuildKit `pnpm-store` cache mount preserves already-downloaded tarballs across retries, so each attempt only re-fetches what's missing.

#### 2. Clear the BuildKit cache mount and rebuild cleanly

If a previous attempt left a half-populated/corrupt cache:

```bash
docker buildx prune --filter type=exec.cachemount --force
DOCKER_BUILDKIT=1 docker build --no-cache -t openclaw:local .
```

`--no-cache` skips layer cache; `buildx prune` clears the mount cache. Combining both eliminates any "stuck cache" hypothesis.

#### 3. Plain retry

BuildKit's cache mount **survives across builds**. Each retry chips away at the missing tarballs. Two or three retries often complete the build on intermittent networks.

```bash
DOCKER_BUILDKIT=1 docker build -t openclaw:local .
```

#### 4. Use the official pre-built image instead

If you're not modifying OpenClaw source, skip the build entirely. From `docs/install/docker.md`:

```bash
docker pull ghcr.io/openclaw/openclaw:latest
docker tag ghcr.io/openclaw/openclaw:latest openclaw:local
```

The published image accepts `--allow-unconfigured` and works identically with the WS bootstrap flow.

#### 5. Move the build to a beefier / better-connected machine

A cloud VM, wired connection, or CI runner usually completes the build first try. Local home wifi / corporate proxies / saturated VPNs are the most common networks that hit this.

### Diagnostic to confirm root cause before retrying

```bash
time curl -fsSI -o /dev/null https://registry.npmjs.org/@zed-industries%2fcodex-acp
time curl -fsSI -o /dev/null https://registry.npmjs.org/@anthropic-ai%2fsdk
time curl -fsSI -o /dev/null https://registry.npmjs.org/typescript
```

Healthy: each returns `HTTP/2 200` in well under 2 seconds.
Unhealthy: any one taking 30+ seconds confirms registry/network is the culprit — Fix #1 is mandatory.

### Notes

- The `[WARN]` messages on `*-win32-*` / `*-darwin-*` packages during the `build` stage are **non-fatal noise** on Linux builds. They are optional platform binaries; pnpm marks them skipped if fetches fail. Don't kill the build just because of them.
- The `runtime-assets` stage is where failure becomes terminal — that's the symptom to watch.
- Docker Desktop default VM is often 2 GB RAM; OpenClaw build wants **≥ 4 GB** (≥ 6 GB safer). Memory pressure can manifest as slow network in the VM.
- `curl error 23` (`CURLE_WRITE_ERROR`) in the WARN messages can also indicate **disk-full** on the Docker daemon's filesystem — check `docker system df` and `df -h /var/lib/docker`.

### References

- Dockerfile: `Dockerfile:126` (runtime-assets stage)
- OpenClaw package depending on codex-acp: `extensions/acpx/package.json:12` → `"@zed-industries/codex-acp": "0.15.0"`
- Docs section: `docs/install/docker.md` — build prerequisites + EAI_AGAIN troubleshooting
- Related doc in this folder: `openclaw-docker-build-and-run.md` § 14 (Common build/run failures)

---

## Issue #2 — `docker run` fails with `mkdirat ... permission denied` on nested bind mount

**Date:** 2026-05-30
**Severity:** Runtime (container fails to start)
**Status:** Workaround documented; not a code bug — bind-mount layout issue

### Symptom

`docker run` returns a container ID but immediately fails with:

```
docker: Error response from daemon: failed to create task for container:
failed to create shim task: OCI runtime create failed: runc create failed:
unable to start container process: error during container init:
error mounting "/host_mnt/Users/rajendra/openclaw-docker/workspace"
to rootfs at "/home/node/.openclaw/workspace":
create mountpoint for /home/node/.openclaw/workspace mount:
make mountpoint "/home/node/.openclaw/workspace":
mkdirat /var/lib/docker/rootfs/overlayfs/<id>/home/node/.openclaw/workspace:
permission denied
```

### Reproduction

Use **three sibling** host directories with **nested container paths**:

```bash
mkdir -p ~/openclaw-docker/state ~/openclaw-docker/workspace ~/openclaw-docker/auth-profile-secrets

docker run -d --name openclaw \
  -v ~/openclaw-docker/state:/home/node/.openclaw \
  -v ~/openclaw-docker/workspace:/home/node/.openclaw/workspace \
  -v ~/openclaw-docker/auth-profile-secrets:/home/node/.config/openclaw \
  ... openclaw:local node openclaw.mjs gateway --allow-unconfigured --bind lan --port 18789
```

### Root cause

Two bind mounts whose **container paths are nested** but **host paths are siblings**:

- Host `~/openclaw-docker/state` → container `/home/node/.openclaw`
- Host `~/openclaw-docker/workspace` → container `/home/node/.openclaw/workspace`

When Docker mounts the first, the contents of `/home/node/.openclaw` become whatever is in `~/openclaw-docker/state` — which is empty (the Dockerfile's pre-created `workspace/` subdir is hidden under the bind-mount). When Docker tries to mount the second at `/home/node/.openclaw/workspace`, that subdirectory doesn't exist, so runc tries to `mkdirat` the mountpoint inside the overlay filesystem and Docker Desktop's file-share layer denies it.

The repo's `docker-compose.yml` avoids this by using **nested host paths** for the two mounts (workspace inside the OPENCLAW_CONFIG_DIR by default), so the inner mountpoint exists on the host before Docker tries to use it.

### Fix priority

#### 1. Drop the separate workspace mount — recommended

Workspace is a subdirectory of state on the container anyway. Just put workspace inside state on the host and use **two** mounts instead of three:

```bash
docker rm -f openclaw

mkdir -p ~/openclaw-docker/state/workspace
mkdir -p ~/openclaw-docker/auth-profile-secrets

docker run -d --name openclaw \
  ... \
  -v ~/openclaw-docker/state:/home/node/.openclaw \
  -v ~/openclaw-docker/auth-profile-secrets:/home/node/.config/openclaw \
  -p 127.0.0.1:18789:18789 \
  openclaw:local \
  node openclaw.mjs gateway --allow-unconfigured --bind lan --port 18789
```

#### 2. Keep three mounts but pre-create the nested mountpoint inside state

```bash
docker rm -f openclaw
mkdir -p ~/openclaw-docker/state/workspace  # mountpoint must exist inside state
# ... then re-run with all three -v flags
```

The bind-mounted `~/openclaw-docker/workspace` then overlays the pre-existing `state/workspace` directory inside the container.

#### 3. Match docker-compose convention with nested host paths

```bash
mkdir -p ~/.openclaw-host/.openclaw/workspace
mkdir -p ~/.openclaw-host/.openclaw-secrets

docker run -d --name openclaw \
  ... \
  -v ~/.openclaw-host/.openclaw:/home/node/.openclaw \
  -v ~/.openclaw-host/.openclaw/workspace:/home/node/.openclaw/workspace \
  -v ~/.openclaw-host/.openclaw-secrets:/home/node/.config/openclaw \
  ...
```

### Notes

- This is **not** a real permissions problem. uid 1000 vs your host user uid 501 (macOS) does not cause this specific error — that would surface later as EACCES on writes, not as a runc init failure.
- Restarting Docker Desktop or `chmod -R 777 ~/openclaw-docker` does **not** fix it. The mountpoint must exist before runc tries to use it.
- Hint that this is a layout problem and not a privileges problem: `runc` runs as root inside the Docker VM. If it were a true permission issue, it would be on `/var/lib/docker/...` which is owned by root — runc would have access.

### References

- Dockerfile mount-point pre-creation: `Dockerfile:293–301` (the `install -d -m 0700 -o node -g node /home/node/.openclaw/workspace` line — pre-existing dir gets shadowed by the bind mount)
- Compose default that avoids the trap: `docker-compose.yml:35–36` (nested defaults `${HOME:-/tmp}/.openclaw/workspace`)
- SETUP doc updated: `bootstrap/SETUP.md` step 3 + step 4
- Companion: `openclaw-docker-build-and-run.md` § 14 (Common build/run failures)

---

## Issue #3 — macOS `chown -R 1000:1000` on bind-mount dir locks out both host AND container

**Date:** 2026-05-30
**Severity:** Runtime — blocks any file write into the bind-mounted state directory
**Status:** Workaround documented; SETUP.md fixed; not a code bug — host/container uid mismatch

### Symptom

After running `sudo chown -R 1000:1000 ~/openclaw-docker` on macOS as previously suggested in step 3 of SETUP.md, any attempt to write to the state directory fails with `Permission denied`:

**From the host shell:**
```
$ cat > ~/openclaw-docker/state/openclaw.json <<'EOF'
> ...
> EOF
zsh: permission denied: /Users/rajendra/openclaw-docker/state/openclaw.json
```

**From inside the container, even as the `node` user (uid 1000):**
```
$ docker exec -i openclaw sh -c 'cat > /home/node/.openclaw/openclaw.json' <<'EOF'
> ...
> EOF
sh: 1: cannot create /home/node/.openclaw/openclaw.json: Permission denied
```

Same root cause for both: neither side can write to the bind-mounted directory.

### Reproduction

```bash
mkdir -p ~/openclaw-docker/state/workspace
sudo chown -R 1000:1000 ~/openclaw-docker      # this is the trap on macOS

docker run ... -v ~/openclaw-docker/state:/home/node/.openclaw ... openclaw:local ...

# Now neither the Mac user (uid 501) nor the container's node (uid 1000) can write.
```

### Root cause

The chown sets the host filesystem ownership to uid 1000 — a uid that has no corresponding user on macOS. Docker Desktop on Mac translates host ownership into the container's namespace via virtiofs, but the translation expects host ownership to belong to the **Docker Desktop user** (which maps to your Mac uid, typically 501), not to a manually-set Linux uid.

After the chown:

- The **Mac host user** (uid 501) is no longer the owner → `permission denied` on host writes.
- The **container's `node` user** (uid 1000) sees the directory as owned by something virtiofs reports as uid 1000-but-with-no-write-permission-from-this-namespace → `permission denied` on in-container writes.

On native Linux, this chown is **correct and necessary** — host uid 1000 directly matches the container's `node` user. The bug was assuming the same instruction worked cross-platform.

### Fix priority

#### 1. Quick recovery — `sudo chmod -R 777` and seed config via `docker exec` — recommended

This is the fastest path back to a working state without recreating directories or restarting the container:

```bash
sudo chmod -R 777 ~/openclaw-docker

docker exec -i openclaw sh -c 'cat > /home/node/.openclaw/openclaw.json' <<'EOF'
{
  "gateway": {
    "controlUi": {
      "dangerouslyDisableDeviceAuth": true
    }
  }
}
EOF

docker exec openclaw cat /home/node/.openclaw/openclaw.json   # verify
docker restart openclaw
sleep 5
curl -fsS http://127.0.0.1:18789/healthz
```

The `chmod 777` is a security downgrade locally but the directory is in your home, not exposed anywhere — same threat model as your `.ssh` directory minus the mode 700.

#### 2. Clean recovery — revert the chown then rely on Docker Desktop's translation

```bash
sudo chown -R "$(id -u):$(id -g)" ~/openclaw-docker
docker restart openclaw
```

Docker Desktop translates your Mac uid → the container's `node` user automatically when host ownership belongs to you. After this, both sides can write again.

#### 3. Full reset — nuke and start over

If perms are too scrambled to untangle:

```bash
docker rm -f openclaw
sudo rm -rf ~/openclaw-docker
mkdir -p ~/openclaw-docker/state/workspace
mkdir -p ~/openclaw-docker/auth-profile-secrets
# DO NOT chown on macOS — Docker Desktop handles uid mapping for you
# Re-run docker run from SETUP.md step 4
```

### Notes

- **Linux users:** the chown to uid 1000 is the right thing — keep doing it. The container's `node` user shares uid 1000 with the host namespace directly, no translation layer.
- **macOS users:** skip the chown entirely. Docker Desktop's virtiofs handles the uid mapping. Your `.openclaw` dir should stay owned by your Mac user.
- Don't try to "fix" this by `chown -R node` inside the container — `node` is uid 1000 in the container and that's what the host already has. The problem is the translation layer expecting the host owner to be your Mac uid.
- The Dockerfile pre-creates `/home/node/.openclaw` with mode `0700` owned by `node:node` (Dockerfile:293–301). Bind mounts shadow those perms with whatever the host directory has.

### References

- SETUP.md step 3 (updated): platform-aware chown instructions
- SETUP.md step 7.5 (added): seed config files via `docker exec` (avoids host-perm issues regardless of platform)
- SETUP.md troubleshooting table (updated): rows for both `zsh: permission denied` and `sh: cannot create ...` symptoms
- Companion: `openclaw-docker-build-and-run.md` § 14 (Common build/run failures)
- Docker Desktop uid translation: <https://docs.docker.com/desktop/settings/mac/#file-sharing>

---

## Issue #4 — WS scopes cleared to `[]` when bootstrap runs from outside Docker container's network namespace

**Date:** 2026-05-30
**Severity:** Runtime — blocks every scope-gated RPC after a successful handshake
**Status:** Workaround documented (sidecar pattern); ships as `run-in-sidecar.sh`

### Symptom

`hello-ok` succeeds but `negotiated scope:` is empty. Then every scope-gated RPC fails:

```
→ connecting to ws://127.0.0.1:18789
✓ connected to OpenClaw 2026.5.26
  scopes negotiated:           <-- EMPTY

→ health                       <-- works (unscoped)
✓ { ... }

→ models.list (state-before)
✗ Gateway error: {"code":"INVALID_REQUEST","message":"missing scope: operator.read"}
```

### Reproduction

1. Run OpenClaw gateway in Docker with `-p 127.0.0.1:18789:18789` (bridge networking).
2. Run any WS client from the host with `client.id: "gateway-client"` + `client.mode: "backend"` + no device identity, presenting the shared token.

### Root cause

From `docs/gateway/protocol.md`:

> *"WS clients normally include `device` identity during `connect` (operator + node). The only device-less operator exceptions are explicit trust paths: ... direct-loopback `gateway-client` backend RPCs authenticated with the shared gateway token/password."*

Keyword: **direct-loopback**. From inside the gateway container, connections from the host through `-p 127.0.0.1:18789` arrive on the Docker bridge interface (e.g. `172.17.0.1`), not on the container's own `127.0.0.1`. The exception doesn't fire. The Gateway runs `shouldClearUnboundScopesForMissingDeviceIdentity` and reduces declared scopes to `[]`.

`gateway.controlUi.dangerouslyDisableDeviceAuth: true` did **not** restore scopes in testing — that key may only apply to Control UI HTTP origins, not arbitrary backend WS connects.

### Fix priority

#### 1. Run scripts in a sidecar container that shares the gateway's network namespace — recommended

Mirrors the OpenClaw `docker-compose.yml` pattern (the `openclaw-cli` service uses `network_mode: "service:openclaw-gateway"`).

```bash
docker run --rm \
  --network=container:openclaw \
  -v "$(pwd)":/work -w /work \
  -e OPENCLAW_GATEWAY_URL="ws://127.0.0.1:18789" \
  -e OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN" \
  ... \
  node:24-bookworm-slim \
  sh -c 'npm install --silent && npm run bootstrap'
```

From inside the sidecar, `ws://127.0.0.1:18789` is true loopback from the gateway's POV. The `gateway-client` backend exception fires, scopes preserved.

The bootstrap project ships `run-in-sidecar.sh` to wrap this. Usage: `./run-in-sidecar.sh <script-name>`.

#### 2. Implement real device pairing in the client

The proper long-term answer for production: generate Ed25519 keypair, sign the `connect.challenge` nonce with the v3 payload format (`docs/gateway/protocol.md` "Device identity + pairing"), persist the resulting `deviceToken` from `hello-ok.auth.deviceToken`. The Gateway never clears your scopes after that. Requires ~150 lines of crypto-careful code.

#### 3. SSH-tunnel from a remote host

For non-Docker setups, `ssh -L 18789:127.0.0.1:18789 user@gateway-host`. From your laptop, `ws://127.0.0.1:18789` then tunnels through the SSH connection and arrives on the gateway's actual loopback — exception fires.

### Notes

- The bootstrap project's `run-in-sidecar.sh` first pulls `node:24-bookworm-slim` (~50 MB), so the first run takes ~30 seconds. Subsequent runs reuse the cached image and `node_modules` (mounted from host).
- The wrapper checks that the gateway container is running before launching the sidecar, so you get a clear error instead of a cryptic `--network=container:...` failure.
- Watch mode (`./run-in-sidecar.sh watch`) needs interactivity, so the wrapper adds `-it` automatically for that one script.

### References

- `docs/gateway/protocol.md` — device-less exceptions list, `shouldClearUnboundScopesForMissingDeviceIdentity` behavior
- `docker-compose.yml:96` (service definition for `openclaw-cli`) — the sidecar pattern in the OpenClaw repo
- `bootstrap/run-in-sidecar.sh` — the wrapper that fixes this
- `bootstrap/README.md` § "Why the sidecar?" — narrative version of this root cause

---

## Issue #5 — `config.patch` requires `baseHash` even though the schema marks it Optional

**Date:** 2026-05-30
**Severity:** Runtime — blocks every config write after the first one
**Status:** Workaround in `bootstrap.ts` via `configPatch()` helper

### Symptom

```
→ config.patch — openai + anthropic provider + default model
✗ Gateway error: {"code":"INVALID_REQUEST","message":"config base hash required; re-run config.get and retry"}
```

### Reproduction

Call `config.patch` with only `raw`:

```typescript
await client.rpc("config.patch", { raw: JSON.stringify(patch) });
```

### Root cause

`src/gateway/protocol/schema/config.ts` declares `baseHash` as `Type.Optional(NonEmptyString)` in `ConfigPatchParamsSchema`. The runtime gateway, however, **requires** it once an active config exists, as an optimistic-concurrency-control token. This prevents two simultaneous writers from clobbering each other's changes — if your `baseHash` doesn't match the current state, the patch is rejected and you have to re-fetch.

The "Optional" in the schema means callers can omit it; the validator catches the missing value and returns this specific error message telling you to re-fetch.

### Fix

Fetch the current snapshot, extract `hash` (or `baseHash`, depending on Gateway version), include it on every `config.patch` call. After a successful patch the hash changes, so each patch re-fetches.

```typescript
async function configPatch(
  client: GatewayClient,
  patch: Record<string, unknown>,
): Promise<unknown> {
  const current = await client.rpc<Record<string, unknown>>("config.get", {});
  const hash =
    typeof current["hash"] === "string" ? (current["hash"] as string)
    : typeof current["baseHash"] === "string" ? (current["baseHash"] as string)
    : undefined;

  return client.rpc("config.patch", {
    raw: JSON.stringify(patch),
    ...(hash ? { baseHash: hash } : {}),
  });
}
```

The bootstrap project's `src/bootstrap.ts` includes this helper and uses it for every config write. The README's "Extending the bootstrap" section warns that any new `config.patch` calls must use it too.

### Notes

- This is **good behavior** — the alternative would be silent lost writes when two scripts race.
- The field name in the `config.get` response is `hash` in the version I tested (`2026.5.26`). Older or newer versions might use `baseHash`. The helper tries both.
- `config.apply` and `config.set` use the same `ConfigApplyLikeParamsSchema` shape and the same baseHash requirement.

### References

- Schema: `src/gateway/protocol/schema/config.ts:22–43` (`ConfigSetParamsSchema`, `ConfigApplyLikeParamsSchema`)
- Bootstrap implementation: `bootstrap/src/bootstrap.ts` — `configPatch()` helper
- README extension guide: `bootstrap/README.md` § "Two gotchas to know"

---

## Issue #6 — `models.providers.<id>.baseUrl` validated as required min-length-1 string

**Date:** 2026-05-30
**Severity:** Runtime — blocks declaring a model provider with only `apiKey`
**Status:** Workaround in `bootstrap.ts` (passes explicit defaults)

### Symptom

```
→ config.patch — openai provider + default model
✗ Gateway error: {"code":"UNAVAILABLE","message":"Error: Config validation failed: models.providers.openai.baseUrl: Too small: expected string to have >=1 characters"}
```

### Reproduction

Patch a provider entry with only `apiKey`:

```typescript
const patch = {
  models: {
    providers: {
      openai: { apiKey: openaiKey }   // no baseUrl
    }
  }
};
```

### Root cause

The Gateway version I tested (`2026.5.26`) validates `models.providers.<id>` entries with `baseUrl` as a non-empty string. In examples around the public docs, `baseUrl` is shown as optional — implying it defaults to the provider's canonical endpoint. This Gateway version's validator treats the missing/empty value as a hard error.

### Fix

Always pass `baseUrl` explicitly:

```typescript
{
  openai: {
    apiKey: openaiKey,
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  },
  anthropic: {
    apiKey: anthropicKey,
    baseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
  },
}
```

### Notes

- For Azure OpenAI, vLLM, or any OpenAI-compatible proxy, set `OPENAI_BASE_URL` in your env. The bootstrap honors it.
- This is also a hint that the docs may be out of date relative to the validator. When the Gateway returns `Config validation failed: <path>: <constraint>`, the path tells you exactly which field needs a value — read it literally.

### References

- Bootstrap implementation: `bootstrap/src/bootstrap.ts` — provider config block
- `.env.example` — `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL` overrides
- Public docs that show baseUrl as optional (out of sync with current validator): `docs/providers/openai.md`, `docs/providers/anthropic.md`

---

## Issue #7 — Empty-string env var defeats `??` fallback for `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`

**Date:** 2026-05-30
**Severity:** Bootstrap-blocking — surfaces as Gateway validation error
**Status:** Fixed in `src/bootstrap.ts`

### Symptom

`./run-in-sidecar.sh bootstrap` fails on the OpenAI provider patch:

```
→ config.patch — openai provider + default model
✗ invalid config: models.providers.openai.baseUrl: Too small: expected string to have >=1 characters
```

The error is identical to Issue #6 — but the original Issue #6 fix (defaulting `baseUrl` explicitly in bootstrap.ts) had a subtle hole that this issue closes.

### Reproduction

1. Set `OPENAI_API_KEY` on the host.
2. Do **not** set `OPENAI_BASE_URL` on the host.
3. Run `./run-in-sidecar.sh bootstrap`.

### Root cause

The sidecar wrapper passes envs through with `:-` shell defaulting:

```bash
-e OPENAI_BASE_URL="${OPENAI_BASE_URL:-}"
```

When `OPENAI_BASE_URL` is unset on the host, this becomes `-e OPENAI_BASE_URL=""`. Inside the sidecar, `process.env.OPENAI_BASE_URL` is the **empty string**, not `undefined`.

`bootstrap.ts` then did:

```typescript
baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
```

`??` only falls back on `null` / `undefined` — **not** empty string. So `baseUrl` resolves to `""`, the patch ships an empty `baseUrl`, and the Gateway's validator rejects it.

### Fix

Use `||` instead of `??` for these env-driven defaults — `||` falls back on any falsy value, including the empty string. Now in `src/bootstrap.ts`:

```typescript
baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
baseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
```

### Notes

- This is a general gotcha when shell-passed envs interact with `??`. Anywhere a script accepts a `-e FOO="${FOO:-}"` pattern from a wrapper, the consumer needs `||` not `??`.
- An alternative would be to change the wrapper to omit unset envs entirely (so `process.env.OPENAI_BASE_URL` would be `undefined` inside the sidecar). But that's more complex than just using `||`, and `||` is the right operator semantically here anyway: "use this if it has a meaningful value, otherwise default."

### References

- Bootstrap implementation: `bootstrap/src/bootstrap.ts` — provider config block
- Companion issue: ISSUES.md #6 (the original baseUrl requirement)
- Wrapper that introduces the empty-string env: `bootstrap/run-in-sidecar.sh`

---

<!--
## Issue template for future entries

## Issue #N — One-line title

**Date:** YYYY-MM-DD
**Severity:** {Build-blocking | Runtime | Cosmetic}
**Status:** {Open | Workaround | Fixed in vX.Y.Z}

### Symptom
(Paste the exact error. Trim noise but keep file paths and codes.)

### Reproduction
(Steps that consistently trigger it.)

### Root cause
(What's actually wrong, grounded in source if possible.)

### Fix priority
1. (Recommended fix.)
2. (Fallback.)
3. (Nuclear option.)

### Notes
- (Observations, gotchas, related issues.)

### References
- (Repo files, doc paths, upstream issues.)
-->
