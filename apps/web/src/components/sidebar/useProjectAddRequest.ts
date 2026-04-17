import { useEffect, useRef } from "react";

export function dispatchProjectAddRequest(input: {
  shouldBrowseForProjectImmediately: boolean;
  onPickFolder: () => void | Promise<void>;
  onRevealPathEntry: () => void;
}): void {
  if (input.shouldBrowseForProjectImmediately) {
    void input.onPickFolder();
    return;
  }

  input.onRevealPathEntry();
}

export function useProjectAddRequest(input: {
  projectAddRequestNonce: number;
  shouldBrowseForProjectImmediately: boolean;
  onPickFolder: () => void | Promise<void>;
  onRevealPathEntry: () => void;
}) {
  const onPickFolderRef = useRef(input.onPickFolder);
  const onRevealPathEntryRef = useRef(input.onRevealPathEntry);

  onPickFolderRef.current = input.onPickFolder;
  onRevealPathEntryRef.current = input.onRevealPathEntry;

  useEffect(() => {
    if (input.projectAddRequestNonce === 0) {
      return;
    }

    dispatchProjectAddRequest({
      shouldBrowseForProjectImmediately: input.shouldBrowseForProjectImmediately,
      onPickFolder: () => onPickFolderRef.current(),
      onRevealPathEntry: () => onRevealPathEntryRef.current(),
    });
  }, [input.projectAddRequestNonce, input.shouldBrowseForProjectImmediately]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "open-project") return;

      dispatchProjectAddRequest({
        shouldBrowseForProjectImmediately: input.shouldBrowseForProjectImmediately,
        onPickFolder: () => onPickFolderRef.current(),
        onRevealPathEntry: () => onRevealPathEntryRef.current(),
      });
    });

    return () => {
      unsubscribe?.();
    };
  }, [input.shouldBrowseForProjectImmediately]);
}
