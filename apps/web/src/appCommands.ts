import { type KeybindingCommand } from "contracts";

const APP_COMMAND_EVENT = "shioricode:app-command";

export type AppCommand = Extract<
  KeybindingCommand,
  "terminal.toggle" | "diff.toggle" | "browser.toggle"
>;

interface AppCommandEventDetail {
  command: AppCommand;
}

function isAppCommand(value: unknown): value is AppCommand {
  return value === "terminal.toggle" || value === "diff.toggle" || value === "browser.toggle";
}

export function dispatchAppCommand(command: AppCommand): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<AppCommandEventDetail>(APP_COMMAND_EVENT, {
      detail: { command },
    }),
  );
}

export function subscribeAppCommand(handler: (command: AppCommand) => void): () => void {
  if (typeof window === "undefined") return () => {};

  const listener = (event: Event) => {
    const detail = event instanceof CustomEvent ? (event.detail as unknown) : null;
    if (!detail || typeof detail !== "object" || !("command" in detail)) return;
    const command = detail.command;
    if (!isAppCommand(command)) return;
    handler(command);
  };

  window.addEventListener(APP_COMMAND_EVENT, listener);
  return () => {
    window.removeEventListener(APP_COMMAND_EVENT, listener);
  };
}
