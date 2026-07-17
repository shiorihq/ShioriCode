import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  browserProjectUrl,
  desktopProjectUrl,
  hasGraphicalSession,
  openShioriCodeDirectory,
  resolveOpenDirectory,
  resolveUrlOpener,
  type OpenCliDependencies,
} from "./openCli";

describe("openCli", () => {
  it("resolves and validates the requested directory", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-open-"));
    expect(resolveOpenDirectory(directory)).toBe(path.resolve(directory));
    expect(() => resolveOpenDirectory(path.join(directory, "missing"))).toThrow(
      "Directory does not exist",
    );
  });

  it("builds desktop and browser project URLs", () => {
    expect(desktopProjectUrl("project one")).toBe(
      "shioricode://app/index.html#/?project=project%20one",
    );
    expect(browserProjectUrl("http://localhost:3773", "project one")).toBe(
      "http://localhost:3773/?project=project+one",
    );
  });

  it("selects platform-native URL openers", () => {
    expect(resolveUrlOpener("shioricode://app/index.html", "darwin")).toEqual({
      command: "open",
      args: ["shioricode://app/index.html"],
    });
    expect(resolveUrlOpener("https://example.com", "linux")).toEqual({
      command: "xdg-open",
      args: ["https://example.com"],
    });
    expect(resolveUrlOpener("https://example.com", "win32")).toEqual({
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", "https://example.com"],
    });
  });

  it("recognizes headless Linux sessions", () => {
    expect(hasGraphicalSession("linux", {})).toBe(false);
    expect(hasGraphicalSession("linux", { DISPLAY: ":0" })).toBe(true);
    expect(hasGraphicalSession("darwin", {})).toBe(true);
  });

  it("opens an existing project in a running Desktop instance", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-desktop-"));
    const openedUrls: string[] = [];
    let disposed = false;
    const dependencies: OpenCliDependencies = {
      graphicalSessionAvailable: () => true,
      openExternalUrl: async (url) => {
        openedUrls.push(url);
      },
      connectToRecordedBackend: async () =>
        ({
          record: { launcher: "desktop" },
          rpc: {
            orchestration: {
              getSnapshot: async () => ({
                projects: [{ id: "project-1", workspaceRoot: directory }],
              }),
            },
            dispose: async () => {
              disposed = true;
            },
          },
        }) as unknown as Awaited<ReturnType<OpenCliDependencies["connectToRecordedBackend"]>>,
      waitForRecordedBackend: async () => null,
      withCliContext: (async () => {
        throw new Error("browser fallback should not run");
      }) as OpenCliDependencies["withCliContext"],
    };

    await expect(openShioriCodeDirectory({ directory }, dependencies)).resolves.toMatchObject({
      target: "desktop",
      url: "shioricode://app/index.html#/?project=project-1",
    });
    expect(openedUrls).toEqual(["shioricode://app/index.html#/?project=project-1"]);
    expect(disposed).toBe(true);
  });

  it("falls back to the local web UI when Desktop cannot open", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-browser-"));
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-home-"));
    fs.writeFileSync(
      path.join(baseDir, "server-instance.json"),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        port: 4321,
        baseDir,
        startedAt: new Date().toISOString(),
        wsUrl: "ws://127.0.0.1:4321/ws",
        authToken: null,
        launcher: "web",
      }),
    );
    const openedUrls: string[] = [];
    const dependencies: OpenCliDependencies = {
      graphicalSessionAvailable: () => true,
      openExternalUrl: async (url) => {
        openedUrls.push(url);
        if (url.startsWith("shioricode:")) {
          throw new Error("Desktop protocol is unavailable");
        }
      },
      connectToRecordedBackend: async () => null,
      waitForRecordedBackend: async () => null,
      withCliContext: (async (_input, run) =>
        run({
          baseDir,
          rpc: {},
          snapshot: {
            projects: [{ id: "project-2", workspaceRoot: directory }],
          },
        } as never)) as OpenCliDependencies["withCliContext"],
    };

    await expect(
      openShioriCodeDirectory({ directory, baseDir }, dependencies),
    ).resolves.toMatchObject({
      target: "browser",
      url: "http://localhost:4321/?project=project-2",
    });
    expect(openedUrls).toEqual([
      "shioricode://app/index.html",
      "http://localhost:4321/?project=project-2",
    ]);
  });

  it("fails clearly without starting a backend on a headless host", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-headless-"));
    let contextCalls = 0;
    const dependencies: OpenCliDependencies = {
      graphicalSessionAvailable: () => false,
      openExternalUrl: async () => {
        throw new Error("should not open");
      },
      connectToRecordedBackend: async () => null,
      waitForRecordedBackend: async () => null,
      withCliContext: (async () => {
        contextCalls += 1;
        throw new Error("should not start");
      }) as OpenCliDependencies["withCliContext"],
    };

    await expect(openShioriCodeDirectory({ directory }, dependencies)).rejects.toThrow(
      "On a headless server, connect from ShioriCode Desktop or mobile using ShioriCode Link instead.",
    );
    expect(contextCalls).toBe(0);
  });
});
