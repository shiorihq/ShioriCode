import { type KeybindingCommand, type ResolvedKeybindingsConfig } from "contracts";
import { resolveShortcutCommand, type ShortcutEventLike } from "~/keybindings";

const APP_SIDEBAR_SHORTCUT_COMMANDS = new Set<KeybindingCommand>([
  "sidebar.toggle",
  "project.add",
  "pullRequests.open",
]);

export function resolveAppSidebarShortcutCommand(
  event: ShortcutEventLike & { defaultPrevented?: boolean },
  keybindings: ResolvedKeybindingsConfig,
  options: {
    terminalFocus: boolean;
    terminalOpen: boolean;
    platform?: string;
  },
): KeybindingCommand | null {
  const command = resolveShortcutCommand(event, keybindings, {
    ...(options.platform != null ? { platform: options.platform } : {}),
    context: {
      terminalFocus: options.terminalFocus,
      terminalOpen: options.terminalOpen,
    },
  });

  if (!command || !APP_SIDEBAR_SHORTCUT_COMMANDS.has(command)) {
    return null;
  }

  return command;
}
