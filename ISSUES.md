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
