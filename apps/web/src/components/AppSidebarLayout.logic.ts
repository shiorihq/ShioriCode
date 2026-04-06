import { type ResolvedKeybindingsConfig } from "contracts";
import { resolveShortcutCommand, type ShortcutEventLike } from "~/keybindings";

export function shouldHandleSidebarToggleShortcut(
  event: ShortcutEventLike & { defaultPrevented?: boolean },
  keybindings: ResolvedKeybindingsConfig,
  options: {
    terminalFocus: boolean;
    terminalOpen: boolean;
  },
): boolean {
  if (
    resolveShortcutCommand(event, keybindings, {
      context: {
        terminalFocus: options.terminalFocus,
        terminalOpen: options.terminalOpen,
      },
    }) === "sidebar.toggle"
  ) {
    return true;
  }

  return !event.defaultPrevented;
}
