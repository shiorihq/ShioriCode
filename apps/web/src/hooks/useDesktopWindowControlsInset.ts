import { useEffect, useState } from "react";

import { isElectron } from "~/env";
import { isMacPlatform } from "~/lib/utils";
import { resolveWindowControlsLeftInset } from "~/windowControls";

export function useDesktopWindowControlsInset(): number {
  const [leftInset, setLeftInset] = useState(() =>
    resolveWindowControlsLeftInset({
      isElectron,
      isMac: typeof navigator !== "undefined" && isMacPlatform(navigator.platform),
      inset: null,
    }),
  );

  useEffect(() => {
    const isMac = isMacPlatform(navigator.platform);
    if (!isElectron || !isMac) {
      setLeftInset(0);
      return;
    }

    let cancelled = false;
    const bridge = window.desktopBridge;
    const insetPromise = bridge?.getWindowControlsInset?.();

    if (!insetPromise) {
      setLeftInset(resolveWindowControlsLeftInset({ isElectron: true, isMac: true, inset: null }));
      return;
    }

    void insetPromise
      .then((inset) => {
        if (cancelled) {
          return;
        }
        setLeftInset(resolveWindowControlsLeftInset({ isElectron: true, isMac: true, inset }));
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setLeftInset(
          resolveWindowControlsLeftInset({ isElectron: true, isMac: true, inset: null }),
        );
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return leftInset;
}
