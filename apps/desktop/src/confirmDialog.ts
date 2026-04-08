import { type BrowserWindow, dialog } from "electron";

const CONFIRM_BUTTON_INDEX = 1;

type DesktopConfirmDialogOptions = {
  cancelLabel?: string;
  confirmLabel?: string;
  detail?: string;
  title?: string;
};

export async function showDesktopConfirmDialog(
  message: string,
  ownerWindow: BrowserWindow | null,
  options?: DesktopConfirmDialogOptions,
): Promise<boolean> {
  const normalizedMessage = message.trim();
  if (normalizedMessage.length === 0) {
    return false;
  }

  const dialogOptions = {
    type: "question" as const,
    buttons: [options?.cancelLabel ?? "No", options?.confirmLabel ?? "Yes"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: normalizedMessage,
    ...(options?.title ? { title: options.title } : {}),
    ...(options?.detail ? { detail: options.detail } : {}),
  };
  const result = ownerWindow
    ? await dialog.showMessageBox(ownerWindow, dialogOptions)
    : await dialog.showMessageBox(dialogOptions);
  return result.response === CONFIRM_BUTTON_INDEX;
}
