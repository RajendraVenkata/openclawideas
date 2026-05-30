/**
 * Minimal OpenClaw Gateway WebSocket client.
 *
 * Implements the protocol documented in:
 *   - docs/gateway/protocol.md (frame model, handshake)
 *   - src/gateway/protocol/version.ts (PROTOCOL_VERSION = 4)
 *
 * Wire shape (from protocol.md):
 *   Request : { type: "req",   id, method, params }
 *   Response: { type: "res",   id, ok, payload | error }
 *   Event   : { type: "event", event, payload, seq?, stateVersion? }
 *
 * Handshake:
 *   server  -> event { event: "connect.challenge", payload: { nonce, ts } }
 *   client  -> req   { method: "connect", params: { ...auth + client + role + scopes } }
 *   server  -> res   { ok: true, payload: { type: "hello-ok", ...snapshot, policy } }
 *
 * Device pairing is skipped for trusted same-process backend clients on
 * direct-loopback connections that authenticate with the shared token. From
 * protocol.md:
 *   "Trusted same-process backend clients (client.id: 'gateway-client',
 *    client.mode: 'backend') may omit device on direct loopback connections
 *    when they authenticate with the shared gateway token/password."
 *
 * That's why we set client.id = "gateway-client" and client.mode = "backend"
 * below. Use a paired-device flow when connecting from outside loopback.
 */

import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import WebSocket from "ws";

/** Matches src/gateway/protocol/version.ts */
const PROTOCOL_VERSION = 4;

/** Default per-RPC timeout (ms). Same as the reference client. */
const RPC_TIMEOUT_MS = 30_000;

/** Connect-challenge wait budget (ms). */
const CONNECT_CHALLENGE_TIMEOUT_MS = 15_000;

type Frame =
  | { type: "req"; id: string; method: string; params: unknown }
  | { type: "res"; id: string; ok: true; payload: unknown }
  | { type: "res"; id: string; ok: false; error: unknown }
  | {
      type: "event";
      event: string;
      payload?: unknown;
      seq?: number;
      stateVersion?: number;
    };

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export type GatewayEvent = {
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: number;
};

export type ClientOptions = {
  url: string;
  token: string;
  /**
   * Scopes to request. The Gateway negotiates and returns the effective set
   * in hello-ok.auth.scopes. Defaults to a full operator-admin set so the
   * bootstrap script can do everything (config writes, channel start, agents).
   */
  scopes?: string[];
};

export type HelloOk = {
  type: "hello-ok";
  protocol: number;
  server: { version: string; connId: string };
  features?: { methods?: string[]; events?: string[] };
  snapshot?: unknown;
  auth: { role: string; scopes: string[]; deviceToken?: string };
  policy: {
    maxPayload: number;
    maxBufferedBytes: number;
    tickIntervalMs: number;
  };
};

export class GatewayClient {
  private ws: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly eventListeners = new Set<(ev: GatewayEvent) => void>();
  private connected = false;
  private hello: HelloOk | null = null;

  constructor(private readonly opts: ClientOptions) {}

  /** Establishes WS, performs handshake, returns hello-ok payload. */
  async connect(): Promise<HelloOk> {
    if (this.ws) throw new Error("already connected");

    this.ws = new WebSocket(this.opts.url, {
      maxPayload: 25 * 1024 * 1024,
    });

    return await new Promise<HelloOk>((resolve, reject) => {
      let challengeReceived = false;
      let challengeTimer: NodeJS.Timeout | null = setTimeout(() => {
        challengeTimer = null;
        if (!challengeReceived) {
          this.cleanup();
          reject(new Error("timeout waiting for connect.challenge"));
        }
      }, CONNECT_CHALLENGE_TIMEOUT_MS);

      this.ws!.on("open", () => {
        // Don't send anything yet — wait for the server-pushed challenge.
      });

      this.ws!.on("message", (raw: WebSocket.RawData) => {
        let frame: Frame;
        try {
          frame = JSON.parse(raw.toString()) as Frame;
        } catch {
          return; // ignore non-JSON
        }

        // Pre-connect: handle the challenge, then send our connect request.
        if (
          !this.connected &&
          frame.type === "event" &&
          frame.event === "connect.challenge"
        ) {
          challengeReceived = true;
          if (challengeTimer) {
            clearTimeout(challengeTimer);
            challengeTimer = null;
          }
          // Reply with `connect`. This is the FIRST request frame.
          const id = randomUUID();
          this.pending.set(id, {
            resolve: (payload) => {
              const hello = payload as HelloOk;
              this.hello = hello;
              this.connected = true;
              resolve(hello);
            },
            reject,
            timer: setTimeout(() => {
              this.pending.delete(id);
              reject(new Error("connect timeout"));
            }, RPC_TIMEOUT_MS),
          });
          const connectFrame = {
            type: "req" as const,
            id,
            method: "connect",
            params: {
              minProtocol: PROTOCOL_VERSION,
              maxProtocol: PROTOCOL_VERSION,
              client: {
                id: "gateway-client",
                version: "0.1.0",
                platform: platform(),
                mode: "backend",
              },
              role: "operator",
              scopes: this.opts.scopes ?? [
                "operator.admin",
                "operator.read",
                "operator.write",
                "operator.pairing",
                "operator.approvals",
              ],
              caps: [],
              commands: [],
              permissions: {},
              auth: { token: this.opts.token },
            },
          };
          this.ws!.send(JSON.stringify(connectFrame));
          return;
        }

        this.handleFrame(frame);
      });

      this.ws!.on("error", (err) => {
        this.cleanup();
        reject(err);
      });

      this.ws!.on("close", (code, reason) => {
        const reasonStr = reason.toString();
        const err = new Error(
          `WebSocket closed (${code})${reasonStr ? ": " + reasonStr : ""}`,
        );
        // Reject any in-flight RPCs.
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          this.pending.delete(id);
          p.reject(err);
        }
        this.cleanup();
        if (!this.connected) reject(err);
      });
    });
  }

  /** Invokes a Gateway RPC method, returns the typed payload. */
  async rpc<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (!this.ws || !this.connected) {
      throw new Error("not connected — call connect() first");
    }
    const id = randomUUID();
    return await new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (payload) => resolve(payload as T),
        reject,
        timer: setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`rpc timeout: ${method}`));
        }, RPC_TIMEOUT_MS),
      });
      this.ws!.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  /** Subscribes a callback to server-push events. Returns an unsubscribe fn. */
  onEvent(cb: (ev: GatewayEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  /** The negotiated hello-ok payload (available after connect()). */
  helloOk(): HelloOk {
    if (!this.hello) throw new Error("not connected");
    return this.hello;
  }

  /** Closes the WS gracefully. */
  async close(): Promise<void> {
    if (!this.ws) return;
    const ws = this.ws;
    this.cleanup();
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      try {
        ws.close(1000, "client disconnect");
      } catch {
        resolve();
      }
    });
  }

  private handleFrame(frame: Frame): void {
    if (frame.type === "res") {
      const p = this.pending.get(frame.id);
      if (!p) return; // unknown id — drop
      this.pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.ok) {
        p.resolve(frame.payload);
      } else {
        const err = new Error(
          `Gateway error: ${JSON.stringify(frame.error)}`,
        );
        // Attach the structured error for callers that want to inspect it.
        (err as Error & { gatewayError?: unknown }).gatewayError = frame.error;
        p.reject(err);
      }
      return;
    }
    if (frame.type === "event") {
      for (const cb of this.eventListeners) {
        try {
          cb({
            event: frame.event,
            payload: frame.payload,
            seq: frame.seq,
            stateVersion: frame.stateVersion,
          });
        } catch {
          // ignore listener errors
        }
      }
      return;
    }
    // Ignore stray req frames from server — protocol forbids them.
  }

  private cleanup(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws = null;
    }
    this.connected = false;
  }
}

/** Reads env vars used by all scripts. Throws if required ones are missing. */
export function readEnv(): { url: string; token: string } {
  const url = process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18789";
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) {
    throw new Error(
      "OPENCLAW_GATEWAY_TOKEN is not set. Export it or put it in .env.",
    );
  }
  return { url, token };
}
