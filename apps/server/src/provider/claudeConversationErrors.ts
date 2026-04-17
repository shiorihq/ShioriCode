export function isClaudeMissingConversationErrorMessage(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("no conversation found with session id") ||
    normalized.includes("conversation not found with session id")
  );
}
