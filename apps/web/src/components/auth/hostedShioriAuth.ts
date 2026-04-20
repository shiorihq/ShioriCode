import type { HostedPasswordAuthInput } from "contracts";

import { convexDeploymentUrl, convexStorageKey } from "../../convex/config";
import { ensureNativeApi } from "../../nativeApi";

function extractErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return null;
}

function sanitizeHostedShioriAuthErrorMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  if (/temporary or disposable email addresses are not allowed/i.test(trimmed)) {
    return "Temporary or disposable email addresses are not allowed";
  }

  const uncaughtMatch = /uncaught error:\s*([^\n]+)/i.exec(trimmed);
  const rawPrimaryLine = (uncaughtMatch?.[1] ?? trimmed.split(/\r?\n/u)[0] ?? "").trim();
  const primaryLine = rawPrimaryLine
    .replace(/\s+at\s.+$/u, "")
    .replace(/\s+called by client$/iu, "")
    .trim();

  if (
    primaryLine.length > 0 &&
    !/^server error$/iu.test(primaryLine) &&
    !/^\[convex /iu.test(primaryLine)
  ) {
    return primaryLine;
  }

  const firstMeaningfulLine = trimmed
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(
      (line) =>
        line.length > 0 &&
        !/^server error$/iu.test(line) &&
        !/^\[convex /iu.test(line) &&
        !/^at\s/iu.test(line) &&
        !/^called by client$/iu.test(line),
    );

  return firstMeaningfulLine ?? trimmed;
}

export function toHostedShioriAuthErrorMessage(error: unknown): string {
  const rawMessage = extractErrorMessage(error);
  const message = rawMessage ? sanitizeHostedShioriAuthErrorMessage(rawMessage) : null;
  if (!message) {
    return "Authentication failed. Please try again.";
  }

  if (
    /invalidsecret/i.test(message) ||
    /invalidaccountid/i.test(message) ||
    /invalid credentials/i.test(message)
  ) {
    return "Invalid email or password. Please try again.";
  }

  if (/toomanyfailedattempts/i.test(message)) {
    return "Too many failed sign-in attempts. Please wait a moment and try again.";
  }

  return message;
}

export function resolveHostedShioriRedirectTarget(
  currentLocationHref: string | undefined,
): string | undefined {
  const trimmed = currentLocationHref?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function withHostedShioriRedirect<T extends Record<string, string>>(
  params: T,
  currentLocationHref: string | undefined,
): T | (T & { redirectTo: string }) {
  const redirectTo = resolveHostedShioriRedirectTarget(currentLocationHref);
  return redirectTo ? { ...params, redirectTo } : params;
}

const JWT_STORAGE_KEY = "__convexAuthJWT";
const REFRESH_TOKEN_STORAGE_KEY = "__convexAuthRefreshToken";

function writeConvexAuthTokens(tokens: { token: string; refreshToken: string }) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(convexStorageKey(JWT_STORAGE_KEY, convexDeploymentUrl), tokens.token);
  window.localStorage.setItem(
    convexStorageKey(REFRESH_TOKEN_STORAGE_KEY, convexDeploymentUrl),
    tokens.refreshToken,
  );
}

export async function signInWithHostedPasswordDesktop(
  params: HostedPasswordAuthInput,
): Promise<{ signingIn: boolean }> {
  const api = ensureNativeApi();
  const result = await api.server.hostedPasswordAuth(params);

  if (!result.signingIn || !result.token || !result.refreshToken) {
    return { signingIn: false };
  }

  writeConvexAuthTokens({
    token: result.token,
    refreshToken: result.refreshToken,
  });
  await api.server.setShioriAuthToken(result.token);
  window.location.reload();
  return { signingIn: true };
}
