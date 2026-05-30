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
