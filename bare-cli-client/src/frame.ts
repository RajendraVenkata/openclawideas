// RFC6455 WebSocket frame codec (client side). Same shape as the gateway's
// ws-frame.ts; the client MASKS outgoing frames (required by the spec).
import { randomBytes } from "node:crypto";

export const OPCODE = { text: 0x1, close: 0x8, ping: 0x9, pong: 0xa } as const;

export type WsFrame = { opcode: number; payload: Buffer };

export function parseFrame(buf: Buffer): { frame: WsFrame; rest: Buffer } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    len = Number(buf.readBigUInt64BE(offset));
    offset += 8;
  }
  let mask: Buffer | undefined;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  const raw = buf.subarray(offset, offset + len);
  const payload = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) payload[i] = mask ? raw[i] ^ mask[i & 3] : raw[i];
  return { frame: { opcode, payload }, rest: buf.subarray(offset + len) };
}

export function encodeFrame(opcode: number, payload: Buffer, mask = false): Buffer {
  const len = payload.length;
  const header: number[] = [0x80 | opcode];
  const maskBit = mask ? 0x80 : 0;
  if (len < 126) {
    header.push(maskBit | len);
  } else if (len < 65536) {
    header.push(maskBit | 126, (len >> 8) & 0xff, len & 0xff);
  } else {
    header.push(maskBit | 127);
    const big = Buffer.alloc(8);
    big.writeBigUInt64BE(BigInt(len));
    for (const byte of big) header.push(byte);
  }
  const parts: Buffer[] = [Buffer.from(header)];
  if (mask) {
    const key = randomBytes(4);
    const body = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) body[i] = payload[i] ^ key[i & 3];
    parts.push(key, body);
  } else {
    parts.push(payload);
  }
  return Buffer.concat(parts);
}

export function encodeText(text: string, mask = false): Buffer {
  return encodeFrame(OPCODE.text, Buffer.from(text, "utf8"), mask);
}
