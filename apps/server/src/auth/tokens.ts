/**
 * Opaque token primitives for sessions and WebSocket tickets.
 *
 * Tokens are high-entropy random strings; only their SHA-256 hash is persisted.
 * Comparisons that an attacker could influence use constant-time equality.
 *
 * @module auth/tokens
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Generate a URL-safe opaque token. */
export function generateToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

/** SHA-256 hex digest used to store tokens at rest. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison of two hex digests of equal length. */
export function safeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length || left.length === 0) {
    return false;
  }
  let leftBuffer: Buffer;
  let rightBuffer: Buffer;
  try {
    leftBuffer = Buffer.from(left, "hex");
    rightBuffer = Buffer.from(right, "hex");
  } catch {
    return false;
  }
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/** Constant-time comparison of two UTF-8 strings (length is not hidden). */
export function safeEqualUtf8(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}
