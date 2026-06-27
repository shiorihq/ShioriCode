/**
 * Minimal cookie parsing/serialization for the session cookie.
 *
 * @module auth/cookies
 */

export function parseCookies(header: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) {
    return out;
  }
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    const name = part.slice(0, index).trim();
    if (!name) {
      continue;
    }
    const rawValue = part.slice(index + 1).trim();
    try {
      out[name] = decodeURIComponent(rawValue);
    } catch {
      out[name] = rawValue;
    }
  }
  return out;
}

export interface CookieOptions {
  readonly maxAgeSeconds?: number;
  readonly secure?: boolean;
  readonly sameSite?: "Strict" | "Lax" | "None";
  readonly path?: string;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  segments.push(`Path=${options.path ?? "/"}`);
  segments.push("HttpOnly");
  segments.push(`SameSite=${options.sameSite ?? "Lax"}`);
  if (options.secure) {
    segments.push("Secure");
  }
  if (options.maxAgeSeconds !== undefined) {
    segments.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  }
  return segments.join("; ");
}
