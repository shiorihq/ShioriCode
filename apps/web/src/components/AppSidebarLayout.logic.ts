import { type KeybindingCommand, type ResolvedKeybindingsConfig } from "contracts";
import { resolveShortcutCommand, type ShortcutEventLike } from "~/keybindings";

const APP_SIDEBAR_SHORTCUT_COMMANDS = new Set<KeybindingCommand>([
  "sidebar.toggle",
  "search.open",
  "project.add",
  "pullRequests.open",
  "kanban.open",
  "chat.new",
  "chat.newLocal",
]);

export function resolveAppSidebarShortcutCommand(
  event: ShortcutEventLike & { defaultPrevented?: boolean },
  keybindings: ResolvedKeybindingsConfig,
  options: {
    terminalFocus: boolean;
    terminalOpen: boolean;
    kanbanView?: boolean;
    platform?: string;
  },
): KeybindingCommand | null {
  const command = resolveShortcutCommand(event, keybindings, {
    ...(options.platform != null ? { platform: options.platform } : {}),
    context: {
      terminalFocus: options.terminalFocus,
      terminalOpen: options.terminalOpen,
      kanbanView: options.kanbanView ?? false,
    },
  });

  if (!command || !APP_SIDEBAR_SHORTCUT_COMMANDS.has(command)) {
    return null;
  }

  return command;
}

export function resolveAppTitlebarWindowControlsLeftInset(options: {
  isElectron: boolean;
  isMac: boolean;
  sidebarOpen: boolean;
  windowControlsInset: number;
}): number {
  if (!options.isElectron || !options.isMac || options.sidebarOpen) {
    return 0;
  }

  return Math.max(0, options.windowControlsInset);
}
