/**
 * Password hashing for the ShioriCode owner credential.
 *
 * Uses scrypt from node:crypto (no external dependency). The serialized form
 * embeds the parameters and salt so stored hashes remain verifiable across
 * parameter changes. Verification is constant-time via timingSafeEqual.
 *
 * @module auth/passwords
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
// 128 * N * r bytes of working memory (~16 MiB here); raise the ceiling so the
// chosen parameters are never rejected by the default 32 MiB limit.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** Hash a plaintext password into a self-describing `scrypt$N$r$p$salt$hash` string. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const derived = scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

/** Verify a plaintext password against a previously stored hash. Constant-time. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const n = Number.parseInt(parts[1]!, 10);
  const r = Number.parseInt(parts[2]!, 10);
  const p = Number.parseInt(parts[3]!, 10);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, "base64url");
    expected = Buffer.from(parts[5]!, "base64url");
  } catch {
    return false;
  }
  if (expected.length === 0) {
    return false;
  }

  let derived: Buffer;
  try {
    derived = scryptSync(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
