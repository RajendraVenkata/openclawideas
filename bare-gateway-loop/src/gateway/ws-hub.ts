// ──────────────────────────────────────────────────────────────────────────
// WebSocket hub — the connection registry + protocol layer that the bare loop's
// WS stub was missing. Mirrors real openclaw's shapes (PROTOCOL_VERSION 4,
// connect.challenge → connect → hello-ok, {type:"req"|"res"|"event"}).
//
// Each connected client declares a `name`; the hub maps name → connection(s) and
// can push events to a given name (pushToCli). It also handles the pairing
// methods (pairing.request / pairing.approve) and dispatches cli.send inbound to
// the registered handler (set by the cli channel transport).
// ──────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { OPCODE, encodeFrame, encodeText, parseFrame } from "./ws-frame.js";
import {
  approveChannelPairingCode,
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../pairing/pairing-store.js";

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PROTOCOL_VERSION = 4;

type Conn = { socket: Socket; buffer: Buffer; name?: string; authed: boolean };
type CliInboundHandler = (name: string, text: string) => Promise<void>;

let verifyToken: (token: string | undefined) => boolean = () => false;
let cliInbound: CliInboundHandler | null = null;
const connsByName = new Map<string, Set<Conn>>();

export function configureWsHub(opts: {
  verifyToken: (token: string | undefined) => boolean;
}): void {
  verifyToken = opts.verifyToken;
}

export function setCliInbound(handler: CliInboundHandler): void {
  cliInbound = handler;
}

function send(conn: Conn, obj: unknown): void {
  try {
    conn.socket.write(encodeText(JSON.stringify(obj)));
  } catch {
    /* socket closed */
  }
}

function sendEvent(conn: Conn, event: string, payload: unknown): void {
  send(conn, { type: "event", event, payload });
}

// Push a `chat` event to every connection registered under `name`.
export function pushToCli(name: string, payload: unknown): number {
  const set = connsByName.get(name);
  if (!set) return 0;
  let delivered = 0;
  for (const conn of set) {
    sendEvent(conn, "chat", payload);
    delivered += 1;
  }
  return delivered;
}

function register(conn: Conn): void {
  if (!conn.name) return;
  let set = connsByName.get(conn.name);
  if (!set) {
    set = new Set();
    connsByName.set(conn.name, set);
  }
  set.add(conn);
}

function deregister(conn: Conn): void {
  if (!conn.name) return;
  const set = connsByName.get(conn.name);
  if (set) {
    set.delete(conn);
    if (set.size === 0) connsByName.delete(conn.name);
  }
}

export function handleWsUpgrade(req: IncomingMessage, socket: Socket): void {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1").update(key + WS_MAGIC).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  const conn: Conn = { socket, buffer: Buffer.alloc(0), authed: false };
  sendEvent(conn, "connect.challenge", { ts: Date.now() });

  socket.on("data", (chunk: Buffer) => {
    conn.buffer = Buffer.concat([conn.buffer, chunk]);
    let parsed = parseFrame(conn.buffer);
    while (parsed) {
      conn.buffer = parsed.rest;
      const { opcode, payload } = parsed.frame;
      if (opcode === OPCODE.close) {
        socket.end();
        return;
      }
      if (opcode === OPCODE.ping) {
        socket.write(encodeFrame(OPCODE.pong, payload));
      } else if (opcode === OPCODE.text) {
        void handleMessage(conn, payload.toString("utf8"));
      }
      parsed = parseFrame(conn.buffer);
    }
  });
  socket.on("close", () => deregister(conn));
  socket.on("error", () => deregister(conn));
}

type ReqMessage = {
  type?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
};

async function handleMessage(conn: Conn, raw: string): Promise<void> {
  let msg: ReqMessage;
  try {
    msg = JSON.parse(raw) as ReqMessage;
  } catch {
    return;
  }
  if (msg.type !== "req" || typeof msg.method !== "string") {
    return;
  }
  const params = msg.params ?? {};
  const ok = (payload: unknown) => send(conn, { type: "res", id: msg.id, ok: true, payload });
  const fail = (error: unknown) => send(conn, { type: "res", id: msg.id, ok: false, error });

  // ── handshake ──────────────────────────────────────────────────────────
  if (msg.method === "connect") {
    const auth = params.auth as { token?: string } | undefined;
    if (!verifyToken(auth?.token)) {
      console.log("[ws] connect rejected: invalid token");
      fail({ code: "UNAUTHORIZED" });
      conn.socket.end();
      return;
    }
    const client = params.client as { name?: string } | undefined;
    const name = String(client?.name ?? "").trim();
    if (!name) {
      fail({ code: "NAME_REQUIRED" });
      return;
    }
    conn.authed = true;
    conn.name = name;
    register(conn);
    console.log(`[ws] connected: ${name}`);
    ok({ type: "hello-ok", protocol: PROTOCOL_VERSION, server: { name: "bare-gateway-loop" } });
    return;
  }

  if (!conn.authed || !conn.name) {
    fail({ code: "NOT_CONNECTED" });
    return;
  }

  // ── pairing ────────────────────────────────────────────────────────────
  if (msg.method === "pairing.request") {
    const channel = String(params.channel ?? "cli");
    const approved = await readChannelAllowFromStore(channel, process.env, "default");
    if (approved.includes(conn.name)) {
      ok({ approved: true });
      return;
    }
    const { code } = await upsertChannelPairingRequest({
      channel,
      id: conn.name,
      accountId: "default",
    });
    console.log(`[security] ${channel}: ${conn.name} pairing code ${code} — approve from the operator`);
    ok({ approved: false, pending: true });
    return;
  }

  if (msg.method === "pairing.approve") {
    const channel = String(params.channel ?? "cli");
    const code = String(params.code ?? "");
    const result = await approveChannelPairingCode({ channel, code, accountId: "default" });
    if (!result) {
      fail({ code: "NO_SUCH_CODE" });
      return;
    }
    console.log(`[security] ${channel}: approved ${result.id} (code ${code})`);
    ok({ approved: result.id });
    return;
  }

  // ── inbound message ──────────────────────────────────────────────────────
  if (msg.method === "cli.send") {
    const text = String(params.text ?? "");
    ok({ accepted: true });
    if (cliInbound) {
      await cliInbound(conn.name, text);
    }
    return;
  }

  fail({ code: "UNKNOWN_METHOD", method: msg.method });
}
