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
it does five things in order:

1. **Resolve the port** — which TCP port number to listen on (default `18789`).
2. **Resolve auth** — figure out the secret token/password clients must present.
3. **Start a config watcher** — watch the config file and reload if it changes.
4. **Start the server** — open one network port that speaks both HTTP and WebSocket.
5. **Start the channels** — connect the messaging surfaces (here: WhatsApp) and
   route incoming messages to the agent.

Then it just *waits* for requests and messages until you stop it.

`src/bootstrap.ts` is the conductor — it calls one function (or a few) per step.
Each of those lives in its own file (steps 1–4 are copied from the real OpenClaw
codebase; step 5 is a faithful-shape mini-version). Let's read the helper files
first (the instruments), then the conductor, then the channel subsystem.

```
bootstrap.ts  ── calls ──▶  resolveGatewayPort()        (config/paths.ts)        step 1
              ── calls ──▶  resolveGatewayAuth()         (gateway/auth-resolve.ts) step 2
              ── calls ──▶  resolveGatewayReloadSettings + startGatewayConfigReloader  step 3
              ── calls ──▶  listenGatewayHttpServer()    (gateway/server/http-listen.ts) step 4
              ── calls ──▶  startChannels()              (channels/channel-manager.ts)   step 5
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

> ℹ️ `createBareGatewayHttpServer` also takes a second argument — the channel lookup —
> and serves one extra route (`POST /channels/<id>/inbound`). That's covered in
> **Part 9f**, once we've met the channel subsystem.

---

## Part 9 — Step 5: the channel subsystem (faithful to real OpenClaw)

A **channel** is a connector to a messaging surface (WhatsApp, Telegram, …). Step 5
loads the enabled channel **plugins**, connects their transports, and routes incoming
messages to the agent. This layer uses the **real OpenClaw names and structure** — a
plugin SDK, a catalog, and a WhatsApp plugin under `extensions/` — so it spans a few
more files than the rest of the demo. New TypeScript here: the **open-union trick**,
**identity factory functions**, **path-alias imports**, and **side-effect imports**.

> ⚠️ **Two things are stubbed** (clearly labelled in the files): the **transport**
> (real WhatsApp uses the **Baileys** library — QR pairing, encryption, live network)
> and the **agent** (real is the Pi agent loop). Everything *between* them uses the
> genuine structure.

The real layout, mirrored:

```
src/plugin-sdk/channel-core.ts        the SDK: ChannelPlugin + adapters + factories
src/plugin-sdk/inbound-envelope.ts    routing: channel/peer → { agentId, sessionKey }
src/channels/plugins/catalog.ts       the plugin registry
src/channels/channel-manager.ts       starts channels, wires inbound → agent → outbound
extensions/whatsapp/src/…             the WhatsApp plugin (channel.ts, send.ts, …)
src/agent/run-agent-stub.ts           the agent stand-in
```

### 9a. The plugin SDK — `src/plugin-sdk/channel-core.ts`

This file defines the **contract** a channel plugin must fit. The real shape is split
across several files; we consolidate it. Highlights:

```ts
export type ChannelId = "whatsapp" | "telegram" | "slack" | (string & {});

export type ChannelMessageAdapter = {
  id: ChannelId;
  capabilities: { text: boolean; replyTo?: boolean };
  send: { text: (ctx: ChannelMessageSendContext) => Promise<ChannelMessageSendResult> };
};

export function defineChannelMessageAdapter(adapter: ChannelMessageAdapter): ChannelMessageAdapter {
  return adapter;
}

export type ChannelPlugin = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  outbound?: ChannelOutboundAdapter;
  message?: ChannelMessageAdapter;
  messaging?: ChannelMessagingAdapter;
  transport?: ChannelTransport;
};

export function createChatChannelPlugin(input: ChannelPlugin): ChannelPlugin {
  return input;
}
```

> 📘 **TS — the open-union trick `(string & {})`.** `ChannelId` is `"whatsapp" |
> "telegram" | "slack" | (string & {})`. The literals give you **autocomplete** for the
> known channels, while `(string & {})` quietly allows *any* string too. (Plain
> `string` alone would erase the autocomplete; `string & {}` is a TypeScript quirk that
> keeps the literal suggestions while still accepting all strings.) This is copied from
> the real codebase.

> 📘 **TS — identity "define/create" factory functions.** `defineChannelMessageAdapter`
> and `createChatChannelPlugin` just **return their argument** — at runtime they do
> nothing. Their value is purely at *compile time*: by typing the parameter as
> `ChannelMessageAdapter` / `ChannelPlugin`, they make the editor **check the object
> you pass and autocomplete its fields right there**. This "identity function for
> type-checking + autocomplete" is a very common SDK pattern (think `defineConfig` in
> many tools). The real SDK versions also brand/validate, but the idea is the same.

> 📘 **TS — `type ChannelPlugin = { … }` with optional adapter fields.** Note the real
> contract is a **`type`** (object type), and most fields are optional (`outbound?`,
> `message?`, `transport?`). A plugin supplies only the adapters it needs. (Earlier we
> contrasted `type` vs `interface`; OpenClaw uses `type` here because a plugin is a
> data object assembled by a factory, not a class.)

### 9b. Routing — `src/plugin-sdk/inbound-envelope.ts`

Before the agent runs, an inbound message is **routed** to an agent + session, then
**formatted** into the text the agent sees.

```ts
export function resolveInboundRoute(params: {
  cfg: OpenClawConfig; channel: ChannelId; accountId: string; peer: RoutePeer;
}): Route {
  const agentId = "main";
  const sessionKey =
    params.peer.kind === "direct"
      ? `agent:${agentId}:main`
      : `agent:${agentId}:${params.channel}:${params.peer.kind}:${params.peer.id}`;
  return { agentId, sessionKey };
}
```

**What it does:** maps `(channel, peer)` → `{ agentId, sessionKey }`. A direct message
goes to the main session; a group/channel gets its own session key. The real resolver
walks the most-specific binding; we use the common default-agent case.

> 📘 **JS — building the session key with a template literal.** `` `agent:${agentId}:${params.channel}:…` `` —
> the same `${…}` interpolation you saw before, here used to compute a routing key.

### 9c. The catalog — `src/channels/plugins/catalog.ts`

```ts
const registry = new Map<ChannelId, ChannelPlugin>();

export function registerChannelPlugin(plugin: ChannelPlugin): void {
  registry.set(plugin.id, plugin);
}

export function getEnabledChannelPlugins(cfg: OpenClawConfig): ChannelPlugin[] {
  const channels: ChannelsConfig = cfg.channels ?? {};
  const enabled: ChannelPlugin[] = [];
  for (const plugin of registry.values()) {
    const channelCfg = channels[plugin.id as keyof ChannelsConfig];
    if (channelCfg?.enabled) enabled.push(plugin);
  }
  return enabled;
}
```

**What it does:** keeps a **module-level registry** of every plugin that registered
itself, and returns the ones enabled in config. The real catalog tracks all bundled +
external channel plugins the same way.

> 📘 **JS/TS — a module-level singleton.** `const registry = new Map(...)` at the top of
> the file exists **once** for the whole program (modules are evaluated once and
> cached). Plugins call `registerChannelPlugin(...)` to add themselves to that one
> shared map. This is how plugin systems "discover" plugins without the core importing
> each one directly.

> 📘 **TS — `keyof` + indexed lookup.** `channels[plugin.id as keyof ChannelsConfig]`.
> `keyof ChannelsConfig` is the union of that type's keys (here `"whatsapp"`). The `as`
> tells TS "treat this id as one of those keys" so the index is allowed. The result is
> `WhatsAppChannelConfig | undefined` — hence the `channelCfg?.enabled` check.

### 9d. The WhatsApp plugin — `extensions/whatsapp/src/…`

The plugin is split exactly like the real one. The **leaf send** (`send.ts`):

```ts
export async function sendMessageWhatsApp(to: string, text: string, _options = {}): Promise<{ messageId: string }> {
  console.log(`📤 [whatsapp → ${to}] ${text}`);          // REAL: await sock.sendMessage(jid, { text })
  return { messageId: `wamid.SIMULATED.${to}` };
}
```

The **outbound + message adapter** (`channel-outbound.ts`) wraps it:

```ts
import { defineChannelMessageAdapter, type ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-core.js";
import { sendMessageWhatsApp } from "./send.js";

export const whatsappChannelOutbound: ChannelOutboundAdapter = {
  sendText: async ({ to, text, replyToId }) => sendMessageWhatsApp(to, text, { replyToId }),
};

export const whatsappMessageAdapter = defineChannelMessageAdapter({
  id: "whatsapp",
  capabilities: { text: true, replyTo: true },
  send: { text: async (ctx) => whatsappChannelOutbound.sendText({ to: ctx.to, text: ctx.text, replyToId: ctx.replyToId }) },
});
```

The **plugin itself** (`channel.ts`) assembles the adapters via the factory:

```ts
import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core.js";
import { whatsappChannelOutbound, whatsappMessageAdapter } from "./channel-outbound.js";
import { whatsappTransport } from "./channel.runtime.js";

export const whatsappPlugin: ChannelPlugin = createChatChannelPlugin({
  id: "whatsapp",
  meta: { id: "whatsapp", label: "WhatsApp", selectionLabel: "WhatsApp", docsPath: "/channels/whatsapp", blurb: "…" },
  capabilities: { chatTypes: ["direct", "group"], reactions: true, reply: true, media: true },
  outbound: whatsappChannelOutbound,
  message: whatsappMessageAdapter,
  transport: whatsappTransport,
});
```

And `register.ts` registers it into the catalog by **import side effect**:

```ts
import { registerChannelPlugin } from "openclaw/channels/plugins/catalog.js";
import { whatsappPlugin } from "./channel.js";
registerChannelPlugin(whatsappPlugin);   // runs when this file is first imported
```

> 📘 **TS — path-alias imports `openclaw/plugin-sdk/…`.** The extension imports the SDK
> as `openclaw/plugin-sdk/channel-core.js`, exactly like the real plugin (which imports
> `openclaw/plugin-sdk/*`). That `openclaw/*` prefix is a **path alias** defined in
> `tsconfig.json` (`"paths": { "openclaw/*": ["src/*"] }`), so it resolves to our
> `src/` tree. Aliases keep imports stable and package-like instead of long `../../../`
> relative chains.

> 📘 **JS — side-effect import `import "./register.js"`.** An import with **no `{ … }`**
> doesn't pull in any value — it just **runs the module for its effects**. Importing
> `register.ts` executes its top-level `registerChannelPlugin(whatsappPlugin)` line,
> adding the plugin to the catalog. `bootstrap.ts` does exactly this:
> `import "../extensions/whatsapp/src/register.js";`.

> 📘 **TS — an object literal "satisfying" a type.** `whatsappPlugin: ChannelPlugin =
> createChatChannelPlugin({ … })`. The big object literal is checked against
> `ChannelPlugin` field by field — wrong field name or wrong adapter shape is a compile
> error. No class, no `implements`: a plugin is just a well-typed object.

### 9e. The manager — `src/channels/channel-manager.ts`

This is the gateway side that **starts** channels and wires the full loop.

```ts
const connection = await plugin.transport.connect({
  accountId: "default",
  onInbound: async (msg) => {
    const route = resolveInboundRoute({ cfg, channel: msg.channel, accountId: "default", peer: { kind: "direct", id: msg.from } });
    const envelopeText = formatInboundEnvelope(msg);
    const reply = await deps.runAgent(envelopeText);          // ← the agent
    if (reply) await deliverReply(plugin, msg.from, reply);    // → message.send.text → sendMessageWhatsApp
  },
});
```

**What it does:** for each enabled plugin it calls `transport.connect({ onInbound })`.
When a message arrives, `onInbound` runs the real loop: **route → format → run agent →
deliver reply** (through the plugin's `message.send.text`). `deliverReply` calls
`plugin.message.send.text(...)`, which calls `whatsappChannelOutbound.sendText`, which
calls `sendMessageWhatsApp`.

> 📘 **TS — passing a callback that the transport stores.** `onInbound` is a function we
> hand to `connect`; the transport keeps it and calls it later for each inbound message
> — the same "give Node/the transport a function, it calls you back" pattern as the HTTP
> handlers.

### 9f. How `bootstrap.ts` wires step 5

```ts
import { startChannels, stopChannels, type StartedChannel } from "./channels/channel-manager.js";
import { runAgent } from "./agent/run-agent-stub.js";
import "../extensions/whatsapp/src/register.js";   // side-effect: registers the plugin

const channelsById = new Map<string, StartedChannel>();
const httpServer = createBareGatewayHttpServer(() => resolvedAuth, channelsById);
await listenGatewayHttpServer({ httpServer, bindHost, port });

// STEP 5: load enabled plugins from the catalog + connect their transports
const channels = await startChannels(cfg, { runAgent });
for (const channel of channels) channelsById.set(channel.id, channel);
```

The HTTP route now just **acknowledges** the inbound (the reply goes out the channel,
not the HTTP response — like a real webhook):

```ts
const started = channelsById.get(inboundMatch[1]);
if (!started) { /* 404 */ return; }
await started.connection.simulateInbound(String(body.from ?? "unknown"), String(body.text ?? ""));
res.end(JSON.stringify({ ok: true, channel: started.id, accepted: true }));
```

### The step-5 flow in one picture (real names)

```
curl POST /channels/whatsapp/inbound {from, text}
   └─ HTTP route → started.connection.simulateInbound(from, text)     (📥 stands in for messages.upsert)
        └─ onInbound(msg)
             ├─ resolveInboundRoute → { agentId:"main", sessionKey }   ([channels] routed → …)
             ├─ formatInboundEnvelope(msg)
             ├─ runAgent(envelopeText)                                  ← the agent (stub)
             └─ whatsappMessageAdapter.send.text(ctx)
                  └─ whatsappChannelOutbound.sendText
                       └─ sendMessageWhatsApp(to, text)   (📤  → Baileys in the real plugin)
```

That is the real daemon's **channel ingress → routing → agent run → outbound
delivery**, with the genuine plugin/adapter names — only the transport and the agent
are faked.

---

## Part 10 — How it all runs (the timeline)

1. `tsx` compiles every `.ts` to JS in memory and runs `bootstrap.ts`.
2. The bottom line `main().catch(...)` kicks off `main()`.
3. `main` reads config, then runs steps 1→2→3→4, logging each.
4. `listenGatewayHttpServer` binds the port.
5. Step 5: importing `register.js` (side effect) put `whatsappPlugin` in the catalog;
   `startChannels` reads the enabled plugins and connects each transport. The program
   now sits idle, kept alive by the open server, the file watcher, and the channels.
6. HTTP/WS requests trigger the callbacks in `createBareGatewayHttpServer` — including
   `POST /channels/whatsapp/inbound`, which runs the route→agent→outbound loop.
7. Editing `openclaw.json` triggers the watcher → `loadConfig` → `onConfig` →
   `resolvedAuth` is reassigned → new token takes effect.
8. `Ctrl-C` sends `SIGINT`; the handler stops the channels, stops the watcher, and
   closes the server.

---

## Part 11 — TypeScript cheat-sheet (everything we met)

| Feature | Looks like | Means |
|---|---|---|
| Type annotation | `x: number` | x is a number |
| Optional property/param | `port?: number`, `message?: …` | may be missing |
| Union | `"a" \| "b"` / `string \| null` | one of several |
| Open union | `"a" \| (string & {})` | known literals (autocomplete) + any string |
| Type alias / object type | `type T = { id: string }` | name a shape |
| Function type | `() => void` | shape of a function |
| `readonly` | `readonly cause` | can't be reassigned after set |
| `class` / `extends` | `class GatewayLockError extends Error` | a class (here, a custom error) |
| Parameter property | `constructor(private readonly x)` | declare+assign field in one go |
| `new` | `new Map(...)`, `new Promise(...)` | construct an instance |
| Identity factory | `defineX(cfg): X { return cfg }` | type-checks + autocompletes the arg at the call site |
| `unknown` | `value: unknown` | anything — must narrow before use |
| `any` | (avoided here) | anything — no checking (escape hatch) |
| `void` | `): void` | returns nothing useful |
| Type guard / narrowing | `if (typeof x === "string")` | prove a type, then use it |
| `as` assertion | `data as Config` | "trust me, it's this type" |
| `keyof` | `keyof ChannelsConfig` | the union of a type's keys |
| `import type` | `import type { T }` | import a type only (erased) |
| Inline value+type import | `import { f, type T }` | mix in one line |
| Side-effect import | `import "./register.js"` | run a module for its effects (no values) |
| Path alias import | `import … from "openclaw/plugin-sdk/…"` | tsconfig `paths` → maps to `src/*` |
| Indexed access | `T["field"]` | the type of that field |
| Generic usage | `Promise<T>`, `ChannelPlugin[]` | a container of T |
| Two-param generic | `Map<ChannelId, ChannelPlugin>` | key type, value type |
| `Record<K, V>` | `Record<string, unknown>` | object with K keys, V values |
| Inference | `const n = f()` | TS figures the type out for you |

And the JS operators that pair with them: `?.` (optional chaining), `??` (nullish
default), ternary `a ? b : c`, destructuring `const { x } = obj`, `async/await`,
`class`/`this`/`new`, `for…of`, and callbacks.

---

## Where to go next

- Open each real file alongside this doc and match the `📘` notes to the code.
- Change something and watch TS complain: set `port: "abc"` in `openclaw.json`'s
  *type* expectations, call `resolveGatewayPort(123)` in `bootstrap.ts`, or remove the
  `send` field from `whatsappMessageAdapter` (TS will reject the
  `defineChannelMessageAdapter({…})` call) — the editor underlines it **before** you run.
- Run it and POST to `POST /channels/whatsapp/inbound` (see [README.md](README.md)) to
  watch the step-5 route→agent→outbound loop print live.
- Add a second channel: copy `extensions/whatsapp/` to `extensions/telegram/`, change the
  `id` to `"telegram"`, add `telegram?` to `ChannelsConfig`, import its `register.js` in
  `bootstrap.ts`, and set `channels.telegram.enabled: true`. The catalog + manager need
  **no** other changes — every channel flows through the same `ChannelPlugin` contract.
- Then read [README.md](README.md) for the run/poke commands and the map back to the
  real OpenClaw source, and [`../openclaw-daemon-internals.md`](../openclaw-daemon-internals.md)
  for what happens *after* these steps (the real agent loop, sessions, more channels).
