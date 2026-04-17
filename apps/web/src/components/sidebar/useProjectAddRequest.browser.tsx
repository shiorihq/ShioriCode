import type { DesktopBridge } from "contracts";
import { type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useProjectAddRequest } from "./useProjectAddRequest";

function makeDesktopBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    getWsUrl: () => null,
    getWindowControlsInset: async () => ({ left: 0 }),
    listSystemFonts: async () => [],
    pickFolder: async () => null,
    confirm: async () => true,
    setTheme: async () => undefined,
    setVibrancy: async () => undefined,
    showContextMenu: async () => null,
    openExternal: async () => true,
    onMenuAction: () => () => undefined,
    getUpdateState: async () => {
      throw new Error("getUpdateState not implemented in test");
    },
    checkForUpdate: async () => {
      throw new Error("checkForUpdate not implemented in test");
    },
    downloadUpdate: async () => {
      throw new Error("downloadUpdate not implemented in test");
    },
    installUpdate: async () => {
      throw new Error("installUpdate not implemented in test");
    },
    getCompanionCliState: async () => ({
      status: "not-installed",
      version: null,
      binaryPath: null,
      lastError: null,
      installCommand: null,
    }),
    installCompanionCli: async () => ({
      accepted: false,
      completed: false,
      state: {
        status: "not-installed",
        version: null,
        binaryPath: null,
        lastError: null,
        installCommand: null,
      },
    }),
    onUpdateState: () => () => undefined,
    ...overrides,
  };
}

function ProjectAddRequestHarness(props: {
  projectAddRequestNonce: number;
  shouldBrowseForProjectImmediately: boolean;
  onPickFolder: () => void | Promise<void>;
  onRevealPathEntry: () => void;
}) {
  useProjectAddRequest(props);
  return null;
}

async function mountHarness(element: ReactElement) {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(element, { container: host });

  return {
    screen,
    host,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

afterEach(() => {
  Reflect.deleteProperty(
    window as Window & typeof globalThis & { desktopBridge?: unknown },
    "desktopBridge",
  );
  vi.restoreAllMocks();
});

describe("useProjectAddRequest", () => {
  it("opens the folder picker when a project-add request arrives in immediate-browse mode", async () => {
    const onPickFolder = vi.fn(async () => undefined);
    const onRevealPathEntry = vi.fn();
    const mounted = await mountHarness(
      <ProjectAddRequestHarness
        projectAddRequestNonce={0}
        shouldBrowseForProjectImmediately
        onPickFolder={onPickFolder}
        onRevealPathEntry={onRevealPathEntry}
      />,
    );

    try {
      await mounted.screen.rerender(
        <ProjectAddRequestHarness
          projectAddRequestNonce={1}
          shouldBrowseForProjectImmediately
          onPickFolder={onPickFolder}
          onRevealPathEntry={onRevealPathEntry}
        />,
      );

      await vi.waitFor(() => {
        expect(onPickFolder).toHaveBeenCalledTimes(1);
      });
      expect(onRevealPathEntry).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("reveals the inline path entry when a project-add request arrives in manual mode", async () => {
    const onPickFolder = vi.fn(async () => undefined);
    const onRevealPathEntry = vi.fn();
    const mounted = await mountHarness(
      <ProjectAddRequestHarness
        projectAddRequestNonce={0}
        shouldBrowseForProjectImmediately={false}
        onPickFolder={onPickFolder}
        onRevealPathEntry={onRevealPathEntry}
      />,
    );

    try {
      await mounted.screen.rerender(
        <ProjectAddRequestHarness
          projectAddRequestNonce={1}
          shouldBrowseForProjectImmediately={false}
          onPickFolder={onPickFolder}
          onRevealPathEntry={onRevealPathEntry}
        />,
      );

      await vi.waitFor(() => {
        expect(onRevealPathEntry).toHaveBeenCalledTimes(1);
      });
      expect(onPickFolder).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("routes desktop open-project menu actions through the same project-add handler", async () => {
    const onPickFolder = vi.fn(async () => undefined);
    const onRevealPathEntry = vi.fn();
    const menuListenerRef: {
      current: ((action: string) => void) | null;
    } = { current: null };

    (
      window as Window &
        typeof globalThis & {
          desktopBridge?: DesktopBridge;
        }
    ).desktopBridge = makeDesktopBridge({
      onMenuAction: (listener) => {
        menuListenerRef.current = listener;
        return () => {
          menuListenerRef.current = null;
        };
      },
    });

    const mounted = await mountHarness(
      <ProjectAddRequestHarness
        projectAddRequestNonce={0}
        shouldBrowseForProjectImmediately
        onPickFolder={onPickFolder}
        onRevealPathEntry={onRevealPathEntry}
      />,
    );

    try {
      if (menuListenerRef.current === null) {
        throw new Error("Expected the desktop menu listener to be registered.");
      }
      menuListenerRef.current("open-project");

      await vi.waitFor(() => {
        expect(onPickFolder).toHaveBeenCalledTimes(1);
      });
      expect(onRevealPathEntry).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });
});
