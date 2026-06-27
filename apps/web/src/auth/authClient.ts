import { resolveServerUrl } from "../lib/utils";

export interface AuthSessionDescriptor {
  readonly requireAuth: boolean;
  readonly authConfigured: boolean;
  readonly authenticated: boolean;
  readonly username: string | null;
  readonly sessionId: string | null;
}

/** Resolve an HTTP(S) URL on the server origin (derived from the WebSocket URL). */
function authUrl(pathname: string): string {
  const url = new URL(resolveServerUrl({ pathname }));
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }
  return url.toString();
}

/** Fetch the current auth state. Returns null on network failure (fail-open). */
export async function fetchAuthSession(): Promise<AuthSessionDescriptor | null> {
  try {
    const response = await fetch(authUrl("/api/auth/session"), {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { session?: AuthSessionDescriptor };
    return body.session ?? null;
  } catch {
    return null;
  }
}

export interface LoginResult {
  readonly ok: boolean;
  readonly error?: string;
}

export async function login(username: string, password: string): Promise<LoginResult> {
  try {
    const response = await fetch(authUrl("/api/auth/login"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        username,
        password,
        label: typeof navigator === "undefined" ? undefined : navigator.userAgent,
      }),
    });
    const body = (await response.json().catch(() => null)) as {
      success?: boolean;
      error?: string;
    } | null;
    if (response.ok && body?.success) {
      return { ok: true };
    }
    return { ok: false, error: body?.error ?? `Login failed (${response.status}).` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Network error." };
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch(authUrl("/api/auth/logout"), { method: "POST", credentials: "include" });
  } catch {
    // Best-effort; the server session expires regardless.
  }
}
