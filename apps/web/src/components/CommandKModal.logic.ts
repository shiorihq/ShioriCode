export type CommandKShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
>;

export function shouldToggleCommandK(
  event: CommandKShortcutEvent,
  options: { terminalFocused: boolean },
): boolean {
  if (event.key !== "k") return false;
  if (!(event.metaKey || event.ctrlKey)) return false;
  if (event.shiftKey || event.altKey) return false;
  return !options.terminalFocused;
}
