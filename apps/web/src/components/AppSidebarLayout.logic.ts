import { type ResolvedKeybindingsConfig } from "contracts";
import { resolveShortcutCommand, type ShortcutEventLike } from "~/keybindings";

export function shouldHandleSidebarToggleShortcut(
  event: ShortcutEventLike & { defaultPrevented?: boolean },
  keybindings: ResolvedKeybindingsConfig,
  options: {
    terminalFocus: boolean;
    terminalOpen: boolean;
    platform?: string;
  },
): boolean {
  return (
    resolveShortcutCommand(event, keybindings, {
      ...(options.platform != null && { platform: options.platform }),
      context: {
        terminalFocus: options.terminalFocus,
        terminalOpen: options.terminalOpen,
      },
    }) === "sidebar.toggle"
  );
}
