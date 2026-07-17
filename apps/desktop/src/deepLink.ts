export function extractDesktopDeepLinkArg(argv: readonly string[], scheme: string): string | null {
  for (const arg of argv) {
    const normalized = normalizeDesktopDeepLink(arg, scheme);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

/**
 * Validates and canonicalizes a ShioriCode deep link.
 */
export function normalizeDesktopDeepLink(rawUrl: string, scheme: string): string | null {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== `${scheme}:`) {
    return null;
  }

  if (parsed.username || parsed.password) {
    return null;
  }

  if (parsed.hostname.toLowerCase() !== "app") {
    return null;
  }

  if (parsed.pathname !== "/" && parsed.pathname !== "/index.html") {
    return null;
  }

  const normalized = new URL(`${scheme}://app/index.html`);
  normalized.search = parsed.search;
  normalized.hash = parsed.hash;
  return normalized.toString();
}

export interface DesktopLinkAuthCallback {
  readonly state: string;
  readonly token?: string;
  readonly refreshToken?: string;
  readonly error?: string;
}

/** Extracts the project requested by `shioricode open` from the hash route. */
export function parseDesktopProjectDeepLink(rawUrl: string, scheme: string): string | null {
  const normalized = normalizeDesktopDeepLink(rawUrl, scheme);
  if (!normalized) return null;
  const hash = new URL(normalized).hash;
  if (!hash.startsWith("#/")) return null;

  const route = new URL(hash.slice(1), "https://shioricode.local");
  if (route.pathname !== "/" || route.searchParams.getAll("project").length !== 1) {
    return null;
  }
  return route.searchParams.get("project")?.trim() || null;
}

/** Extracts a one-time Link auth callback without exposing it to the renderer. */
export function parseDesktopLinkAuthCallback(
  rawUrl: string,
  scheme: string,
): DesktopLinkAuthCallback | null {
  const normalized = normalizeDesktopDeepLink(rawUrl, scheme);
  if (!normalized) return null;
  const url = new URL(normalized);
  if (url.searchParams.get("link-auth") !== "callback") return null;

  for (const key of ["link-auth", "state", "token", "refreshToken", "error"]) {
    if (url.searchParams.getAll(key).length > 1) return null;
  }
  const state = url.searchParams.get("state")?.trim();
  const token = url.searchParams.get("token")?.trim();
  const refreshToken = url.searchParams.get("refreshToken")?.trim();
  const error = url.searchParams.get("error")?.trim();
  if (!state || (!error && (!token || !refreshToken))) return null;
  return {
    state,
    ...(token ? { token } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * Resolves the URL that the Electron window should load for a desktop deep link.
 */
export function resolveDesktopDeepLinkWindowUrl(input: {
  rawUrl: string;
  scheme: string;
  isDevelopment: boolean;
  devServerUrl?: string | undefined;
}): string | null {
  const normalized = normalizeDesktopDeepLink(input.rawUrl, input.scheme);
  if (!normalized) {
    return null;
  }

  if (!input.isDevelopment) {
    return normalized;
  }

  const devServerUrl = input.devServerUrl?.trim();
  if (!devServerUrl) {
    return null;
  }

  const deepLink = new URL(normalized);
  const devUrl = new URL(devServerUrl);
  devUrl.search = deepLink.search;
  devUrl.hash = deepLink.hash;
  return devUrl.toString();
}
