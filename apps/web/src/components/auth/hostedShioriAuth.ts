function extractErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return null;
}

export function toHostedShioriAuthErrorMessage(error: unknown): string {
  const message = extractErrorMessage(error);
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
