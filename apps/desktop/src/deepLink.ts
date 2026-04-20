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
  normalized.hash = parsed.hash;
  return normalized.toString();
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
  devUrl.hash = deepLink.hash;
  return devUrl.toString();
}
