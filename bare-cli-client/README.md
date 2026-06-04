# bare-cli-client

A TypeScript command-line client that talks to **bare-gateway-loop** over the gateway
**WebSocket** — send and receive messages, with first-run setup, pairing, and
multi-client support. This is the *faithful* transport: real openclaw clients (the
macOS app, iOS/Android nodes, Control UI) connect over the gateway WS and receive
**pushed events** — exactly what this does.

```
 CLI (alice)  ──WS──►  :18789  connect → hello-ok        (one gateway token)
              ──req──► cli.send {text}                   (your message → the agent)
              ◄─event─ chat {from:"agent", text}         (pushed reply)
 CLI (bob)    ── … same, independent peer …
```

## Run order

1. **Start the gateway first** (`../bare-gateway-loop`): `npm start` — it now serves the
   real WS protocol and a `cli` channel.
2. **Start the client:** `cd bare-cli-client && npm install && npm start`.

## Install as a `bare-cli` command (optional)

Bundle to a single executable (one `node`-runnable file with a shebang) and link it:

```bash
npm install          # includes esbuild
npm run build        # → dist/bare-cli.mjs (executable, ~11kb)
npm link             # puts `bare-cli` on your PATH

bare-cli                                   # run from anywhere
bare-cli --gateway 10.0.0.5:18789          # point at a remote gateway
```

`npm run build` bundles all `src/*` into `dist/bare-cli.mjs` (no `tsx` at runtime — just
Node). To uninstall the global command: `npm unlink -g bare-cli`. For a *fully standalone*
binary (no Node needed), use `bun build src/main.ts --compile --outfile bare-cli`.

## First launch

```
Display name:     alice
Gateway token:    dev-secret-token        ← the gateway's gateway.auth.token
Gateway endpoint: [127.0.0.1:18789]       ← press enter for the default, or set host:port
```
These are saved to `~/.bare-cli/config.json`, so next time it goes straight to chat.

**Endpoint override** (no prompt needed) — handy for an installed binary:
```bash
npm start -- --gateway 10.0.0.5:18789     # or -g 10.0.0.5:18789
BARE_CLI_GATEWAY=10.0.0.5:18789 npm start  # env var
```
Accepts `host:port`, `host` (default port), `ws://…`, `[ipv6]:port`. Defaults to
`127.0.0.1:18789`.

## Pairing (code comes from the gateway console, not chat)

On first connect you're an unknown sender, so:
```
· connected as "alice"
· 🔒 Pairing required — look at the GATEWAY console for your approval code.
Enter approval code:
```
Read the code printed on the **gateway terminal** —
`[security] cli: alice pairing code C1581D` — and type it in. You're paired (persisted
on the gateway), so you won't be asked again, even across restarts.

## Chat

Type messages; agent replies are pushed in:
```
alice  hello there
agent  🤖 (echo agent) [cli] from alice: hello there — …
```

Commands: `/help` · `/status` · `/reset` (clear local config) · `/quit`.

## Multiple clients

Just run more instances with different names (each in its own terminal):
```
npm start            # name: alice
npm start            # name: bob
```
Each connects as a separate **peer**, **pairs independently** (its own console code), and
only receives **its own** replies — the gateway routes by name. (Verified: `bob`'s reply
never reaches `alice`.)

## How it works

| File | Role |
|---|---|
| `src/frame.ts` | RFC6455 WS frame codec (client masks outgoing frames) |
| `src/ws-client.ts` | WS handshake via `http.request` upgrade; `req()`↔`res` by id; pushed events |
| `src/config.ts` | load/save `~/.bare-cli/config.json` |
| `src/pairing.ts` | `pairing.request` → prompt code → `pairing.approve` |
| `src/ui.ts` | readline + ANSI; prints incoming above the input line |
| `src/main.ts` | orchestrator: config → connect → hello-ok → pair → chat loop |

Protocol (mirrors real openclaw, `PROTOCOL_VERSION = 4`): the gateway emits
`connect.challenge`; the client sends a `connect` req (token + name) and gets `hello-ok`;
then `cli.send` reqs go up and `chat` events come down. The gateway side lives in
`../bare-gateway-loop/src/gateway/ws-{frame,hub}.ts` and the `cli` channel in
`../bare-gateway-loop/extensions/cli/`.

## Notes
- One gateway **token** authorizes all clients; the **name** distinguishes them.
- Approvals persist on the gateway (`../bare-gateway-loop`'s pairing store), so a restart
  doesn't force re-pairing.
- Run with `tsx`; the only dependency is `tsx`.
