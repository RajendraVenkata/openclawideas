# Code Walkthrough + TypeScript Primer

A guided read of the **bare-gateway-loop** code, written for someone who knows
**basic JavaScript** and wants to learn **TypeScript** along the way.

We'll do two things at once:

1. **Explain what the code does** — concept by concept, file by file.
2. **Teach TypeScript** — every time a new TS feature shows up, there's a
   `📘 TS` box explaining it in plain terms.

> If you just want to *run* it, see [README.md](README.md). This file is about
> *understanding* it.

---

## Part 0 — What is TypeScript, really?

JavaScript has values but doesn't check what *kind* of value a thing is until the
program runs. If you write `port.toUpperCase()` and `port` is the number `18789`,
JavaScript only crashes **when that line executes**.

**TypeScript is JavaScript + a type checker.** You add little annotations saying
"this is a number", "this is a string", "this function returns a boolean", and a
tool checks your whole program *before* it runs, catching mistakes early. The
browser/Node can't run `.ts` files directly, so TypeScript is **compiled** (a.k.a.
"transpiled") down to plain `.js` first.

In this project we skip the manual compile step using a tool called **`tsx`**,
which compiles-and-runs in one go. That's why `package.json` says:

```json
"start": "tsx src/bootstrap.ts"
```

> 📘 **TS — the golden rule:** Types are *erased* before the code runs. They exist
> only to help you (and the checker) while writing. At runtime, TypeScript behaves
> exactly like the JavaScript it compiled to. Types never make decisions at runtime.

### The handful of TS symbols you'll see everywhere

| Symbol | Meaning | Example |
|---|---|---|
| `: Type` | "this has this type" | `let port: number` |
| `?` (after a name) | "optional — may be missing" | `port?: number` |
| `\|` | "union — one of these" | `"a" \| "b"` |
| `type X = …` | name a shape | `type Mode = "on" \| "off"` |
| `import type` | import a type only (erased at runtime) | `import type { Foo }` |
| `as` | "trust me, treat it as this type" | `data as Config` |

We'll meet each of these in real code below. Also two JS operators that show up a
lot (these are *real runtime JS*, not types):

- `?.` **optional chaining** — `a?.b` reads `b` only if `a` exists, else `undefined`.
- `??` **nullish coalescing** — `a ?? b` uses `a` unless it's `null`/`undefined`, then `b`.

---

## Part 1 — The big picture

The program is a tiny version of the **OpenClaw Gateway daemon** starting up. A
"daemon" is just a program that runs continuously in the background. When it boots,
it does four things in order:

1. **Resolve the port** — which TCP port number to listen on (default `18789`).
2. **Resolve auth** — figure out the secret token/password clients must present.
3. **Start a config watcher** — watch the config file and reload if it changes.
4. **Start the server** — open one network port that speaks both HTTP and WebSocket.

Then it just *waits* for requests until you stop it.

`src/bootstrap.ts` is the conductor — it calls one function per step. Each of those
functions lives in its own file (copied from the real OpenClaw codebase). Let's
read the helper files first (the instruments), then the conductor.

```
bootstrap.ts  ── calls ──▶  resolveGatewayPort()        (config/paths.ts)        step 1
              ── calls ──▶  resolveGatewayAuth()         (gateway/auth-resolve.ts) step 2
              ── calls ──▶  resolveGatewayReloadSettings + startGatewayConfigReloader  step 3
              ── calls ──▶  listenGatewayHttpServer()    (gateway/server/http-listen.ts) step 4
```

---

## Part 2 — The smallest file: `src/utils.ts`

```ts
// VERBATIM — origin: openclaw/src/utils.ts (line ~59)
export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

**What it does:** `sleep(500)` gives you a promise that resolves after 500
milliseconds — a way to "wait" without freezing the program. `setTimeout` is plain
JavaScript; wrapping it in a `Promise` lets you write `await sleep(500)`.

> 📘 **TS — parameter types:** `ms: number` means "the parameter `ms` must be a
> number." In plain JS you'd just write `function sleep(ms)` and nobody checks that
> you passed a number. In TS, calling `sleep("hello")` is a compile-time error.

> 📘 **TS — `export`:** This is actually standard modern JavaScript (ES Modules),
> not TS-specific. `export` makes `sleep` importable from other files via
> `import { sleep } from "./utils.js"`. (Note: even though the file is `utils.ts`,
> imports are written with `.js` — that's a NodeNext rule; the compiler maps it.)

---

## Part 3 — Describing data with *types*: the `types.*.ts` files

Before any logic, the code defines the **shapes** of the data it works with. These
files contain almost no runtime code — they're mostly type definitions. This is the
heart of TypeScript, so we'll go slow.

### `src/config/types.secrets.ts` (the shapes of secrets)

```ts
export type SecretRef = {
  source: "env" | "file" | "exec";
  provider: string;
  id: string;
};
```

> 📘 **TS — `type` alias + object type:** `type SecretRef = { … }` gives a *name*
> to a shape. It says: "a `SecretRef` is an object with a `source`, a `provider`,
> and an `id`." Now anywhere you write `: SecretRef`, TS knows exactly which fields
> must exist. This is like a blueprint; it creates **no** runtime value.

> 📘 **TS — union of literals:** `"env" | "file" | "exec"` is a **string literal
> union**. `source` isn't just *any* string — it must be exactly one of those three
> words. Typo `"enviroment"` → compile error. This is one of TS's most useful
> features and you'll see it constantly (modes, statuses, etc.).

```ts
export type SecretInput = string | SecretRef;
```

A `SecretInput` is **either** a plain `string` **or** a `SecretRef` object. Unions
combine whole types, not just literals.

```ts
export type SecretDefaults = {
  env?: string;
  file?: string;
  exec?: string;
};
```

> 📘 **TS — optional properties (`?`):** `env?: string` means the `env` field *may*
> be present (a string) or *may* be absent entirely. Without the `?`, TS would
> force every `SecretDefaults` to include `env`. Optional fields are everywhere in
> config types because most settings have defaults and can be omitted.

Now a real function:

```ts
export function normalizeSecretInputString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
```

**What it does:** "If `value` is a non-empty string, return it trimmed; otherwise
return `undefined`." Useful for treating `""`, `"   "`, or a non-string as "nothing
provided."

> 📘 **TS — `unknown`:** `value: unknown` means "could be literally anything — a
> string, number, object, null…". It's the *safe* version of `any`. The difference:
> TS won't let you *use* an `unknown` value until you've **narrowed** it. That's
> what `if (typeof value !== "string") return …` does — after that check, TS knows
> `value` is a string on the next line, so `.trim()` is allowed. This pattern
> (check the type, then act) is called a **type guard**.

> 📘 **TS — return type `string | undefined`:** The `: string | undefined` after the
> parentheses declares what the function hands back. Being explicit means if you
> accidentally forget a `return`, TS complains.

> 📘 **JS reminder — ternary:** `trimmed.length > 0 ? trimmed : undefined` is plain
> JS: `condition ? valueIfTrue : valueIfFalse`.

### `src/config/types.gateway.ts` (the shape of gateway config)

This file is *only* types — the blueprint for what `openclaw.json` can contain.

```ts
import type { SecretInput } from "./types.secrets.js";
```

> 📘 **TS — `import type`:** Normal `import` can bring in runtime values *and*
> types. `import type` brings in **only types**, and is fully erased when compiled
> (it produces zero JavaScript). Use it when you only need a type for annotations —
> it makes the compiled output leaner and avoids accidental circular dependencies.

```ts
export type GatewayAuthMode = "none" | "token" | "password" | "trusted-proxy";
```

The four ways the gateway can authenticate clients — again a literal union, so the
rest of the code can `switch` on it safely.

```ts
export type GatewayAuthConfig = {
  mode?: GatewayAuthMode;
  token?: SecretInput;
  password?: SecretInput;
  allowTailscale?: boolean;
  rateLimit?: GatewayAuthRateLimitConfig;
  trustedProxy?: GatewayTrustedProxyConfig;
};
```

Every field is optional (`?`) because a user's config might set none, some, or all
of them. Notice types referencing other types (`GatewayAuthMode`, `SecretInput`,
…) — types compose like Lego.

```ts
export type GatewayConfig = {
  port?: number;
  bind?: GatewayBindMode;
  customBindHost?: string;
  auth?: GatewayAuthConfig;
  reload?: GatewayReloadConfig;
  tailscale?: { mode?: GatewayTailscaleMode };
};
```

This is the whole gateway config shape. `tailscale?: { mode?: … }` shows an
**inline** object type — you don't always need a named `type`; you can describe a
shape right where it's used.

### `src/config/types.openclaw.ts` (the root config)

```ts
export type OpenClawConfig = {
  gateway?: GatewayConfig;
  secrets?: {
    defaults?: SecretDefaults;
  };
};
```

The top-level config object. In the real product this has hundreds of fields; our
slice keeps only the two the startup loop reads. This is the type you'll see passed
around as `cfg` everywhere.

---

## Part 4 — Step 1: resolving the port (`src/config/paths.ts`)

Now actual decision-making logic. The job: decide which port number to listen on.

```ts
export const DEFAULT_GATEWAY_PORT = 18789;
```

> 📘 **JS reminder — `const`:** a value that can't be reassigned. Plain JS.

```ts
export function resolveGatewayPort(
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const envRaw = env.OPENCLAW_GATEWAY_PORT?.trim();
  const envPort = parseGatewayPortEnvValue(envRaw);
  if (envPort !== null) {
    return envPort;
  }
  const configPort = cfg?.gateway?.port;
  if (typeof configPort === "number" && Number.isFinite(configPort)) {
    if (configPort > 0) {
      return configPort;
    }
  }
  return DEFAULT_GATEWAY_PORT;
}
```

**What it does — the precedence rule:**
1. If the environment variable `OPENCLAW_GATEWAY_PORT` is set and valid → use it.
2. Else if `openclaw.json` has `gateway.port` (a positive number) → use it.
3. Else → fall back to `18789`.

This is *why* `OPENCLAW_GATEWAY_PORT=19911 npm start` overrides the config file.

> 📘 **TS — optional parameters with defaults:** `cfg?: OpenClawConfig` means you
> can call `resolveGatewayPort()` with no arguments. `env: … = process.env` gives a
> **default value** — if you don't pass `env`, it uses the real process environment.
> (Defaults are JS; the type annotation is TS.)

> 📘 **JS — `?.` optional chaining, used twice here:**
> - `env.OPENCLAW_GATEWAY_PORT?.trim()` — env vars can be `undefined`; `?.` means
>   "call `.trim()` only if the value exists, otherwise the whole thing is
>   `undefined`." Without `?.`, calling `.trim()` on `undefined` would throw.
> - `cfg?.gateway?.port` — walk into nested objects safely. If `cfg` is missing, or
>   `cfg.gateway` is missing, you get `undefined` instead of a crash.

> 📘 **TS — narrowing again:** `typeof configPort === "number" && Number.isFinite(configPort)`
> proves to TS (and to you) that `configPort` is a usable number before comparing
> `> 0`. `configPort` started as `number | undefined` (because `port?` is optional);
> after the check, TS treats it as `number`.

There's also a private helper, `parseGatewayPortEnvValue`, that turns the raw env
string into a number (handling odd cases like a leaked `"127.0.0.1:18789"` string).
It returns `number | null`:

```ts
function parseGatewayPortEnvValue(raw: string | undefined): number | null { … }
```

> 📘 **TS — `null` vs `undefined`:** TS treats these as two distinct types. This
> codebase uses `null` to mean "explicitly no valid port found" and `undefined` to
> mean "nothing was passed." You'll see `if (envPort !== null)` — a precise check.

> 📘 **No `export` = private:** `parseGatewayPortEnvValue` has no `export`, so it's
> usable only inside this file. This is how modules hide their internals.

The file also has `resolveGatewayBindHost` and `isLoopbackHost` — same ideas:
read `cfg.gateway.bind`, map `"loopback"` → `"127.0.0.1"`, etc. `isLoopbackHost`
returns a `boolean` and just checks the host against known loopback names.

---

## Part 5 — Step 2: resolving auth (three files)

Authentication answers: *"what secret must a client present, and how?"* It's split
into three files: a guard, a credential picker, and the main resolver.

### 5a. The guard — `src/gateway/auth-mode-policy.ts`

```ts
export function assertExplicitGatewayAuthModeWhenBothConfigured(cfg: OpenClawConfig): void {
  if (!hasAmbiguousGatewayAuthModeConfig(cfg)) {
    return;
  }
  throw new Error(EXPLICIT_GATEWAY_AUTH_MODE_REQUIRED_ERROR);
}
```

**What it does:** If the user configured *both* a token *and* a password but didn't
say which `mode` to use, that's ambiguous — so it **throws an error** and refuses to
start. "Fail fast" is safer than guessing.

> 📘 **TS — return type `void`:** `: void` means "this function returns nothing
> useful." It either returns early or throws. Marking it `void` documents intent and
> stops you from accidentally relying on a return value.

> 📘 **JS — `throw`:** plain JS. Throwing an `Error` stops the current function and
> bubbles up until something catches it (in `bootstrap.ts`, the top-level `.catch`
> catches it and prints a message).

### 5b. The credential picker — `src/gateway/credentials.ts`

```ts
export function resolveGatewayCredentialsFromValues(params: {
  configToken?: unknown;
  configPassword?: unknown;
  env?: NodeJS.ProcessEnv;
  tokenPrecedence?: GatewayCredentialPrecedence;
  passwordPrecedence?: GatewayCredentialPrecedence;
}): ResolvedGatewayCredentials {
  const env = params.env ?? process.env;
  const envToken = trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN);
  const envPassword = trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD);
  const configToken = trimCredentialToUndefined(params.configToken);
  const configPassword = trimCredentialToUndefined(params.configPassword);
  const tokenPrecedence = params.tokenPrecedence ?? "env-first";
  const passwordPrecedence = params.passwordPrecedence ?? "env-first";

  const token =
    tokenPrecedence === "config-first"
      ? firstDefined([configToken, envToken])
      : firstDefined([envToken, configToken]);
  …
  return { token, password };
}
```

**What it does:** Looks at the token/password from *both* the config file and the
environment, and picks one based on a precedence setting. `firstDefined([a, b])`
returns the first of the list that isn't empty.

> 📘 **TS — object parameter typing (a HUGE pattern):** Instead of
> `function f(a, b, c, d, e)` (easy to mix up the order), the code takes a **single
> object** and types it inline:
> ```ts
> function resolveGatewayCredentialsFromValues(params: { configToken?: unknown; … }) { … }
> ```
> Callers then write `resolveGatewayCredentialsFromValues({ configToken: …, env: … })`.
> This "named arguments" style is everywhere in this codebase. The type after
> `params:` is just an inline object type describing the allowed keys.

> 📘 **JS — `??` nullish coalescing:** `params.env ?? process.env` = "use
> `params.env`, but if it's `null`/`undefined`, use `process.env` instead." Compare
> to `||`, which also replaces `0`, `""`, `false` — `??` only replaces null/undefined,
> which is usually what you want for defaults.

> 📘 **JS — ternary chaining for precedence:** the `token = cond ? X : Y` picks the
> ordering of the array passed to `firstDefined`. Pure JS, but a clean way to encode
> a rule.

The `trim…` helpers and `firstDefined` are private (no `export` on `firstDefined`).
`trimCredentialToUndefined` additionally rejects unresolved `${ENV_VAR}` placeholders
so a literal `"${OPENCLAW_GATEWAY_TOKEN}"` isn't mistaken for a real secret.

### 5c. The main resolver — `src/gateway/auth-resolve.ts`

This pulls it together into one tidy result object.

```ts
export type ResolvedGatewayAuth = {
  mode: ResolvedGatewayAuthMode;
  modeSource?: ResolvedGatewayAuthModeSource;
  token?: string;
  password?: string;
  allowTailscale: boolean;
  trustedProxy?: GatewayTrustedProxyConfig;
};
```

That's the **output shape**: after resolving, you get a single object describing the
final decision.

The core logic decides the `mode`:

```ts
let mode: ResolvedGatewayAuth["mode"];
let modeSource: ResolvedGatewayAuth["modeSource"];
if (authOverride?.mode !== undefined) {
  mode = authOverride.mode;
  modeSource = "override";
} else if (authConfig.mode) {
  mode = authConfig.mode;
  modeSource = "config";
} else if (password) {
  mode = "password";
  modeSource = "password";
} else if (token) {
  mode = "token";
  modeSource = "token";
} else {
  mode = "token";
  modeSource = "default";
}
```

**What it does — mode precedence:** an explicit override wins; else the configured
`mode`; else if a password exists, password mode; else if a token exists, token
mode; else default to token mode. `modeSource` records *why* — handy for the log
line you saw (`source=token`).

> 📘 **TS — indexed access types `ResolvedGatewayAuth["mode"]`:** This reads "the
> type of the `mode` field inside `ResolvedGatewayAuth`." Instead of repeating the
> union, you point at the existing definition. If the field's type ever changes,
> `mode` here updates automatically. A small but very "TypeScript" move.

> 📘 **JS — `let` vs `const`:** `let mode` is used because it's assigned in different
> branches. `const` would forbid reassignment.

The function ends by returning the assembled object. There's also
`resolveEffectiveSharedGatewayAuth`, which reduces the full result to just
`{ mode, secret }` for the token/password cases (and returns `null` for the others).

> 📘 **TS — function returning `… | null`:** `): EffectiveSharedGatewayAuth | null`
> tells callers "you might get `null`, handle it." TS will then *force* the caller to
> check before using the result — preventing "cannot read property of null" bugs.

---

## Part 6 — Step 3: hot-reload (two files)

### 6a. The settings — `src/gateway/config-reload-settings.ts`

```ts
export type GatewayReloadSettings = {
  mode: GatewayReloadMode;
  debounceMs: number;
};

const DEFAULT_RELOAD_SETTINGS: GatewayReloadSettings = {
  mode: "hybrid",
  debounceMs: 300,
};

export function resolveGatewayReloadSettings(cfg: OpenClawConfig): GatewayReloadSettings {
  const rawMode = cfg.gateway?.reload?.mode;
  const mode =
    rawMode === "off" || rawMode === "restart" || rawMode === "hot" || rawMode === "hybrid"
      ? rawMode
      : DEFAULT_RELOAD_SETTINGS.mode;
  …
  return { mode, debounceMs };
}
```

**What it does:** Read `gateway.reload` from config; if `mode` isn't one of the four
valid words, fall back to `"hybrid"`. Same for `debounceMs` (default 300).

> 📘 **TS — typing a constant object:** `const DEFAULT_RELOAD_SETTINGS: GatewayReloadSettings = {…}`
> annotates the constant with its type. Now if you typo a field name or give `mode`
> an invalid value, TS flags it right at the definition.

> 📘 **TS — validating untyped input:** `cfg` comes from a JSON file, so at runtime
> `mode` could be *any* string (or garbage). The big `=== "off" || …` check is a
> runtime guard that also narrows the type to the valid union. This is the bridge
> between "untrusted outside data" and "trusted typed data."

### 6b. The watcher — `src/gateway/config-reload.ts`

```ts
export function startGatewayConfigReloader(opts: {
  watchPath: string;
  settings: GatewayReloadSettings;
  loadConfig: () => Promise<OpenClawConfig>;
  onConfig: (cfg: OpenClawConfig, settings: GatewayReloadSettings) => void;
}): GatewayConfigReloaderHandle {
  …
  watcher = fsWatch(watchPath, () => scheduleAfter(settings.debounceMs));
  return { stop: async () => { … } };
}
```

**What it does:** Uses Node's `fs.watch` to notice when the config file changes.
When it does, it waits `debounceMs` (so ten rapid saves become one reload), then
calls `loadConfig()` to re-read the file and `onConfig(...)` to hand the new config
back to whoever started the watcher. It returns a `{ stop() }` handle so you can
turn the watcher off later.

> 📘 **TS — function types as fields:** Look at `loadConfig: () => Promise<OpenClawConfig>`.
> This says "`loadConfig` is a **function** that takes no arguments and returns a
> promise of an `OpenClawConfig`." And `onConfig: (cfg, settings) => void` is "a
> function taking those two args and returning nothing." Passing functions as
> arguments is a JS thing (callbacks); *typing* their signatures is the TS part. The
> `=>` here is a **type**, not the arrow function itself.

> 📘 **JS — debounce:** `scheduleAfter` clears any pending timer and sets a new one.
> If changes keep coming, the timer keeps resetting, so the reload only fires once
> things settle. Classic JavaScript pattern using `setTimeout`/`clearTimeout`.

> 📘 **TS — generics peek: `Promise<OpenClawConfig>` and `Set<…>`:** The `<…>` is a
> **type parameter** — "a Promise *of* an OpenClawConfig", "a Set *of* WsClients". A
> `Promise` is a container; the angle brackets say what it contains. You don't define
> generics here, you just *use* built-in ones. (You'll also see `ReturnType<typeof setTimeout>`
> — an advanced helper meaning "whatever type `setTimeout` returns," which differs
> between Node and browsers.)

---

## Part 7 — Step 4: the server (two files)

### 7a. The bind helper — `src/gateway/server/http-listen.ts`

```ts
import type { Server as HttpServer } from "node:http";
import { GatewayLockError } from "../../infra/gateway-lock.js";
import { sleep } from "../../utils.js";

export async function listenGatewayHttpServer(params: {
  httpServer: HttpServer;
  bindHost: string;
  port: number;
}) {
  const { httpServer, bindHost, port } = params;
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => { … reject(err); };
        const onListening = () => { … resolve(); };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);
        httpServer.listen(port, bindHost);
      });
      return; // bound successfully
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE" && attempt < EADDRINUSE_MAX_RETRIES) {
        await closeServerQuietly(httpServer);
        await sleep(EADDRINUSE_RETRY_INTERVAL_MS);
        continue;
      }
      …
      throw new GatewayLockError(`failed to bind … ${String(err)}`, err);
    }
  }
}
```

**What it does:** Tries to "listen" on the port. `httpServer.listen` is asynchronous
and reports success via a `"listening"` event or failure via an `"error"` event, so
the code wraps it in a `Promise` that `resolve`s on the former and `reject`s on the
latter. If the error is `EADDRINUSE` ("address already in use" — another process has
the port), it waits and retries up to 20 times. (**This is exactly what you saw
earlier** when the real gateway was still running on 18789.) If it ultimately fails,
it throws a `GatewayLockError`.

> 📘 **TS — `import { X as Y }` (aliasing):** `import { Server as HttpServer }`
> brings in Node's `Server` type but renames it to `HttpServer` locally — clearer,
> and avoids clashing with other `Server` types. The renaming is a JS feature; here
> it's a `import type`, so types only.

> 📘 **TS — `as` type assertion (escape hatch):** `(err as NodeJS.ErrnoException).code`.
> In a `catch`, `err` has type `unknown` (anything can be thrown). TS won't let you
> read `.code` off `unknown`. `as NodeJS.ErrnoException` says "trust me, treat this
> as a Node system error, which has a `.code`." Use `as` sparingly — it bypasses the
> checker, so *you're* now responsible for being right.

> 📘 **TS — `new Promise<void>(…)`:** the `<void>` says this promise resolves with
> *no* value (you call `resolve()` with nothing). Without it, TS might infer
> `Promise<unknown>`.

> 📘 **JS — destructuring:** `const { httpServer, bindHost, port } = params;` pulls
> the three fields out of the `params` object into local variables. Plain modern JS.

### 7b. The error class — `src/infra/gateway-lock.ts`

```ts
export class GatewayLockError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GatewayLockError";
  }
}
```

**What it does:** A custom error type so callers can tell "couldn't grab the port"
apart from any other error.

> 📘 **TS — parameter properties (`public override readonly cause`):** This is a
> TS-only shortcut. In plain JS you'd write `this.cause = cause` inside the
> constructor. In TS, prefixing a constructor parameter with `public`/`private`/
> `readonly` **automatically** creates and assigns a field of that name. So
> `public override readonly cause?: unknown` declares the field, marks it
> read-only (can't change after construction), and assigns it — all in one line.
> `override` says "I'm intentionally redefining something from the parent `Error`."

> 📘 **JS — `class`, `extends`, `super`, `constructor`:** standard JS classes.
> `extends Error` means "is a kind of Error"; `super(message)` calls the parent
> Error's constructor.

---

## Part 8 — The conductor: `src/bootstrap.ts`

Now the file that uses everything. Top of file — the imports:

```ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { OpenClawConfig } from "./config/types.openclaw.js";
import { resolveGatewayPort, resolveGatewayBindHost, isLoopbackHost } from "./config/paths.js";
import { resolveGatewayAuth, type ResolvedGatewayAuth } from "./gateway/auth-resolve.js";
…
```

> 📘 **TS — mixing values and types in one import:** `import { createServer, type IncomingMessage, … }`
> brings in the *runtime* function `createServer` **and** the *types* `IncomingMessage`/
> `ServerResponse` in one line. The `type` keyword before a name marks just that name
> as type-only. Same trick in `{ resolveGatewayAuth, type ResolvedGatewayAuth }`.

Loading the config:

```ts
async function loadConfig(): Promise<OpenClawConfig> {
  const raw = await readFile(CONFIG_PATH, "utf8");
  const noComments = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  return JSON.parse(noComments) as OpenClawConfig;
}
```

**What it does:** Read the JSON file as text, strip `//` and `/* */` comments (real
JSON doesn't allow comments, but the config uses them), then `JSON.parse` it.

> 📘 **TS — `JSON.parse(...) as OpenClawConfig`:** `JSON.parse` returns `any`
> (anything). The `as OpenClawConfig` tells TS "treat the parsed result as our config
> shape" so the rest of the file gets autocompletion and checking. ⚠️ This is a
> *promise you're making* — TS doesn't actually verify the file matches. (Real
> production code uses a validator like `zod` to check at runtime; that's noted in
> the file map as omitted.)

> 📘 **JS — `async`/`await`:** `async function` lets you use `await`, which pauses
> until a promise resolves (here, reading the file). The function itself returns a
> promise. Standard modern JS.

Now `main()` — the actual sequence (condensed):

```ts
async function main() {
  let cfg = await loadConfig();

  assertExplicitGatewayAuthModeWhenBothConfigured(cfg);          // step 2 guard

  const port = resolveGatewayPort(cfg);                          // STEP 1
  const bindHost = resolveGatewayBindHost(cfg);

  let resolvedAuth = resolveGatewayAuth({                        // STEP 2
    authConfig: cfg.gateway?.auth ?? null,
    tailscaleMode: cfg.gateway?.tailscale?.mode,
  });

  const reloadSettings = resolveGatewayReloadSettings(cfg);      // STEP 3
  const reloader = startGatewayConfigReloader({
    watchPath: CONFIG_PATH,
    settings: reloadSettings,
    loadConfig,
    onConfig: (next) => {
      cfg = next;                                                // swap snapshot
      resolvedAuth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth ?? null, … });
    },
  });

  const httpServer = createBareGatewayHttpServer(() => resolvedAuth);   // STEP 4
  await listenGatewayHttpServer({ httpServer, bindHost, port });
  …
}

main().catch((err) => {
  console.error(`[gateway] startup failed: ${String(err)}`);
  process.exit(1);
});
```

This is the whole story in one function. Things worth pointing out:

> 📘 **TS — type inference (you don't annotate everything!):** Notice `const port =
> resolveGatewayPort(cfg)` has **no** `: number`. TS already knows `resolveGatewayPort`
> returns a number, so `port` is inferred as `number`. Good TS leans on inference;
> you annotate at the *boundaries* (function params/returns, config shapes) and let
> the middle infer itself. Less typing, same safety.

> 📘 **JS — closures capture variables, `let` matters here:** `createBareGatewayHttpServer(() => resolvedAuth)`
> passes a tiny function that returns `resolvedAuth`. Because `resolvedAuth` is a
> `let`, when the reload handler reassigns it, that arrow function will return the
> **new** value next time it's called. That's how a config reload instantly changes
> which token the server accepts — the same trick you tested live.

> 📘 **JS — top-level `main().catch(...)`:** `main` is async (returns a promise), so
> `.catch` handles any error it throws — including the `assert…` guard throwing.
> `process.exit(1)` ends the program with a non-zero ("failure") exit code.

### The server-building helper inside bootstrap

`createBareGatewayHttpServer(getAuth)` builds the HTTP server. Key TS/JS bits:

```ts
function createBareGatewayHttpServer(getAuth: () => ResolvedGatewayAuth) {
  const isAuthorized = (req: IncomingMessage): boolean => {
    const auth = getAuth();
    if (auth.mode === "none") return true;
    const expected = auth.mode === "password" ? auth.password : auth.token;
    if (!expected) return false;
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : header;
    return presented === expected;
  };

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if ((req.headers.upgrade ?? "").toLowerCase() === "websocket") return; // WS handled elsewhere
    if (req.url === "/health") { res.writeHead(200, …); res.end(JSON.stringify({ ok: true })); return; }
    if (!isAuthorized(req)) { res.writeHead(401, …); res.end(…); return; }
    res.writeHead(200, …); res.end(JSON.stringify({ ok: true, you: "authorized", path: req.url }));
  });

  httpServer.on("upgrade", (req, socket) => { /* WebSocket handshake */ });
  return httpServer;
}
```

**What it does:** Creates one HTTP server. For each request it: ignores WebSocket
upgrades (handled by the separate `"upgrade"` listener), answers `/health` without
auth, rejects unauthenticated requests with `401`, and otherwise replies `200`.
The `"upgrade"` handler does the real WebSocket handshake (the SHA-1 + magic-string
dance) — that's how **one port serves both HTTP and WebSocket**.

> 📘 **TS — typed callbacks:** `(req: IncomingMessage, res: ServerResponse) => {…}`
> is an arrow function whose parameters are typed with Node's request/response types,
> so `req.headers`, `req.url`, `res.writeHead`, etc. all autocomplete and are checked.

> 📘 **TS — `getAuth: () => ResolvedGatewayAuth`:** the helper receives a *function*
> that returns the current auth (not the auth value itself). That indirection is
> deliberate — it always reads the latest `resolvedAuth`, so reloads take effect.

---

## Part 9 — How it all runs (the timeline)

1. `tsx` compiles every `.ts` to JS in memory and runs `bootstrap.ts`.
2. The bottom line `main().catch(...)` kicks off `main()`.
3. `main` reads config, then runs steps 1→2→3→4, logging each.
4. `listenGatewayHttpServer` binds the port; the program now sits idle, kept alive
   by the open server and the file watcher.
5. Requests trigger the callbacks in `createBareGatewayHttpServer`.
6. Editing `openclaw.json` triggers the watcher → `loadConfig` → `onConfig` →
   `resolvedAuth` is reassigned → new token takes effect.
7. `Ctrl-C` sends `SIGINT`; the handler stops the watcher and closes the server.

---

## Part 10 — TypeScript cheat-sheet (everything we met)

| Feature | Looks like | Means |
|---|---|---|
| Type annotation | `x: number` | x is a number |
| Optional property/param | `port?: number` | may be missing |
| Union | `"a" \| "b"` / `string \| null` | one of several |
| Type alias | `type T = {…}` | name a shape |
| Object type | `{ id: string }` | shape of an object |
| Function type | `() => void` | shape of a function |
| `unknown` | `value: unknown` | anything — must narrow before use |
| `any` | (avoided here) | anything — no checking (escape hatch) |
| `void` | `): void` | returns nothing useful |
| Type guard / narrowing | `if (typeof x === "string")` | prove a type, then use it |
| `as` assertion | `data as Config` | "trust me, it's this type" |
| `import type` | `import type { T }` | import a type only (erased) |
| Inline value+type import | `import { f, type T }` | mix in one line |
| Indexed access | `T["field"]` | the type of that field |
| Generic usage | `Promise<T>`, `Set<T>` | a container of T |
| Parameter property | `constructor(public readonly x)` | declare+assign field in one go |
| Inference | `const n = f()` | TS figures the type out for you |

And the JS operators that pair with them: `?.` (optional chaining), `??` (nullish
default), ternary `a ? b : c`, destructuring `const { x } = obj`, `async/await`,
classes, and callbacks.

---

## Where to go next

- Open each real file alongside this doc and match the `📘` notes to the code.
- Change something and watch TS complain: set `port: "abc"` in `openclaw.json`'s
  *type* expectations, or call `resolveGatewayPort(123)` in `bootstrap.ts` — the
  editor will underline it in red **before** you run.
- Then read [README.md](README.md) for the run/poke commands and the map back to the
  real OpenClaw source, and [`../openclaw-daemon-internals.md`](../openclaw-daemon-internals.md)
  for what happens *after* these four steps (the agent loop, sessions, channels).
```
