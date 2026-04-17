export function truncate(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength)}...`;
}

export function normalizeProjectTitle(title: string): string {
  const normalized = title.trim();
  return normalized.length > 0 ? normalized : "project";
}
