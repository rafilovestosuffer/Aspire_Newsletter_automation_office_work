import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

export function randomTokenHex(): string {
  return randomBytes(32).toString("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function csrfForToken(secret: string, rawToken: string): string {
  return hmacHex(secret, `csrf:${rawToken}`);
}

export function archiveSig(secret: string, issueKey: string, revision: number, htmlSha256: string): string {
  return hmacHex(secret, `archive:${issueKey}:${revision}:${htmlSha256}`);
}

export function newId(): string {
  return randomBytes(16).toString("hex");
}

export function uuidV4(): string {
  const b = randomBytes(16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
