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
