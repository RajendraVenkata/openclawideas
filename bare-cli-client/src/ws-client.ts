// A tiny WebSocket client (no library): does the upgrade handshake via
// http.request, then speaks the gateway protocol — req↔res correlated by id,
// plus pushed events. Outgoing frames are masked (client requirement).

import http from "node:http";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { OPCODE, encodeFrame, encodeText, parseFrame } from "./frame.js";

type Pending = { resolve: (value: unknown) => void; reject: (err: unknown) => void };

export type WsClient = {
  connect(): Promise<void>;
  req(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (payload: unknown) => void): void;
  close(): void;
};

export function createWsClient(opts: { host: string; port: number }): WsClient {
  let socket: Socket | null = null;
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const emitter = new EventEmitter();

  function handleText(text: string): void {
    let msg: { type?: string; id?: number; ok?: boolean; payload?: unknown; error?: unknown; event?: string };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === "res" && typeof msg.id === "number") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.payload);
      else p.reject(msg.error);
    } else if (msg.type === "event" && typeof msg.event === "string") {
      emitter.emit(msg.event, msg.payload);
    }
  }

  function processBuffer(): void {
    let parsed = parseFrame(buffer);
    while (parsed) {
      buffer = parsed.rest;
      const { opcode, payload } = parsed.frame;
      if (opcode === OPCODE.text) handleText(payload.toString("utf8"));
      else if (opcode === OPCODE.ping && socket) socket.write(encodeFrame(OPCODE.pong, payload, true));
      else if (opcode === OPCODE.close && socket) socket.end();
      parsed = parseFrame(buffer);
    }
  }

  return {
    connect() {
      return new Promise<void>((resolve, reject) => {
        const key = randomBytes(16).toString("base64");
        const request = http.request({
          host: opts.host,
          port: opts.port,
          path: "/",
          headers: {
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Key": key,
            "Sec-WebSocket-Version": "13",
          },
        });
        request.on("upgrade", (_res, sock, head) => {
          socket = sock as Socket;
          buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
          processBuffer();
          socket.on("data", (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            processBuffer();
          });
          socket.on("close", () => {
            // Reject any in-flight requests so callers see a real error (e.g. a
            // connect that was refused) instead of hanging.
            for (const p of pending.values()) p.reject({ code: "CONNECTION_CLOSED" });
            pending.clear();
            emitter.emit("__close", undefined);
          });
          socket.on("error", (err: unknown) => emitter.emit("__error", err));
          resolve();
        });
        request.on("error", reject);
        request.end();
      });
    },
    req(method, params) {
      return new Promise<unknown>((resolve, reject) => {
        if (!socket) {
          reject(new Error("not connected"));
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve, reject });
        socket.write(encodeText(JSON.stringify({ type: "req", id, method, params: params ?? {} }), true));
      });
    },
    on(event, handler) {
      emitter.on(event, handler);
    },
    close() {
      try {
        socket?.end();
      } catch {
        /* already closed */
      }
    },
  };
}
