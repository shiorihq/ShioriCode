import { ThreadId } from "contracts";

const SETTINGS_RETURN_PATH_STORAGE_KEY = "settings_return_path";

function canUseSessionStorage(): boolean {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
}

export function rememberSettingsReturnPath(pathname: string): void {
  if (!canUseSessionStorage() || pathname.startsWith("/settings")) {
    return;
  }

  window.sessionStorage.setItem(SETTINGS_RETURN_PATH_STORAGE_KEY, pathname);
}

export function readSettingsReturnPath(): string | null {
  if (!canUseSessionStorage()) {
    return null;
  }

  return window.sessionStorage.getItem(SETTINGS_RETURN_PATH_STORAGE_KEY);
}

function resolveThreadIdFromPath(pathname: string): ThreadId | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 1) {
    return null;
  }

  const [segment] = segments;
  if (!segment || segment === "pull-requests" || segment === "settings") {
    return null;
  }

  return ThreadId.makeUnsafe(decodeURIComponent(segment));
}

export function resolveSettingsBackNavigation(
  pathname: string | null,
): { to: "/" } | { to: "/pull-requests" } | { to: "/$threadId"; params: { threadId: ThreadId } } {
  if (!pathname || pathname === "/" || pathname.startsWith("/settings")) {
    return { to: "/" };
  }

  if (pathname.startsWith("/pull-requests")) {
    return { to: "/pull-requests" };
  }

  const threadId = resolveThreadIdFromPath(pathname);
  if (threadId) {
    return { to: "/$threadId", params: { threadId } };
  }

  return { to: "/" };
}
