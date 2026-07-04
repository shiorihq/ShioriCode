import { CommandId, MessageId, ProjectId, ThreadId } from "contracts";
import { String, Predicate } from "effect";
import { type CxOptions, cx } from "class-variance-authority";
import { twMerge } from "tailwind-merge";
import * as Random from "effect/Random";
import * as Effect from "effect/Effect";

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}

export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function isWindowsPlatform(platform: string): boolean {
  return /^win(dows)?/i.test(platform);
}

export function isLinuxPlatform(platform: string): boolean {
  return /linux/i.test(platform);
}

export function randomUUID(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Effect.runSync(Random.nextUUIDv4);
}

export const newCommandId = (): CommandId => CommandId.makeUnsafe(randomUUID());

export const newProjectId = (): ProjectId => ProjectId.makeUnsafe(randomUUID());

export const newThreadId = (): ThreadId => ThreadId.makeUnsafe(randomUUID());

export const newMessageId = (): MessageId => MessageId.makeUnsafe(randomUUID());

const isNonEmptyString = Predicate.compose(Predicate.isString, String.isNonEmpty);
const firstNonEmptyString = (...values: unknown[]): string => {
  for (const value of values) {
    if (isNonEmptyString(value)) {
      return value;
    }
  }
  throw new Error("No non-empty string provided");
};

export const resolveServerUrl = (options?: {
  url?: string | undefined;
  protocol?: "http" | "https" | "ws" | "wss" | undefined;
  pathname?: string | undefined;
  searchParams?: Record<string, string> | undefined;
}): string => {
  const rawUrl = firstNonEmptyString(
    options?.url,
    window.desktopBridge?.getWsUrl(),
    import.meta.env.VITE_WS_URL,
    window.location.origin,
  );

  const parsedUrl = new URL(rawUrl);
  if (options?.protocol) {
    parsedUrl.protocol = options.protocol;
  }
  if (options?.pathname) {
    parsedUrl.pathname = options.pathname;
  } else {
    parsedUrl.pathname = "/";
  }
  if (options?.searchParams) {
    parsedUrl.search = new URLSearchParams(options.searchParams).toString();
  }
  return parsedUrl.toString();
};

/**
 * Build an HTTP(S) URL for a server *data route* (attachments, project
 * favicons, …) on the same origin as the WebSocket, carrying the same auth
 * credential the socket uses.
 *
 * These routes are gated by {@link authorizeDataRequest} once remote access is
 * enabled, but a browser `<img>`/`fetch` GET can't set an `Authorization`
 * header and the desktop app has no session cookie — so the legacy `?token=`
 * that the WebSocket URL carries is the only credential they can present. We
 * derive the URL from `resolveServerUrl` (which preserves that query when no
 * `searchParams` are supplied), coerce the ws/wss scheme to http/https, then
 * merge any extra params on top without clobbering the token.
 */
export const resolveDataRouteUrl = (
  pathname: string,
  searchParams?: Record<string, string>,
): string => {
  const url = new URL(resolveServerUrl({ pathname }));
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
};
