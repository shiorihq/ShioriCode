export interface DesktopRemoteConnectionState {
  readonly mode: "local" | "remote";
  readonly remoteUrl: string | null;
  readonly savedRemoteUrls: readonly string[];
}

export const LOCAL_DESKTOP_CONNECTION: DesktopRemoteConnectionState = {
  mode: "local",
  remoteUrl: null,
  savedRemoteUrls: [],
};

const MAX_SAVED_REMOTES = 8;

export function rememberDesktopRemote(
  existing: readonly string[],
  remoteUrl: string,
): readonly string[] {
  return [remoteUrl, ...existing.filter((candidate) => candidate !== remoteUrl)].slice(
    0,
    MAX_SAVED_REMOTES,
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function normalizeDesktopRemoteUrl(
  rawUrl: string,
  options: { readonly allowInsecureLoopback?: boolean } = {},
): string | null {
  const candidate = rawUrl.trim();
  if (!candidate) return null;

  let url: URL;
  try {
    url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
  } catch {
    return null;
  }

  const insecureLoopback =
    options.allowInsecureLoopback === true &&
    url.protocol === "http:" &&
    isLoopbackHostname(url.hostname);
  if (url.protocol !== "https:" && !insecureLoopback) return null;
  if (url.username || url.password) return null;

  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function desktopRemoteWsUrl(remoteUrl: string): string {
  const url = new URL(remoteUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}
