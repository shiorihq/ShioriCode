export function isClaudeMissingConversationErrorMessage(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("no conversation found with session id") ||
    normalized.includes("conversation not found with session id") ||
    normalized.includes("conversation not found for session id") ||
    (normalized.includes("session id") &&
      normalized.includes("conversation") &&
      normalized.includes("not found")) ||
    normalized.includes("could not find conversation") ||
    normalized.includes("failed to resume conversation") ||
    (normalized.includes("resume") &&
      normalized.includes("conversation") &&
      normalized.includes("not found")) ||
    (normalized.includes("stale") && normalized.includes("conversation"))
  );
}
