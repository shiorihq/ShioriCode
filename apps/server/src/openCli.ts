import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  connectToRecordedBackend,
  ensureProjectForCwd,
  resolveCliBaseDir,
  resolveHttpUrl,
  waitForRecordedBackend,
  withCliContext,
  type RecordedBackendConnection,
} from "shared/shioriCodeClient";

const DESKTOP_START_TIMEOUT_MS = 30_000;
const URL_OPENER_TIMEOUT_MS = 10_000;

export type OpenShioriCodeTarget = "desktop" | "browser";

export interface OpenShioriCodeResult {
  readonly directory: string;
  readonly target: OpenShioriCodeTarget;
  readonly url: string;
}

export interface OpenCliDependencies {
  readonly graphicalSessionAvailable: () => boolean;
  readonly openExternalUrl: (url: string) => Promise<void>;
  readonly connectToRecordedBackend: typeof connectToRecordedBackend;
  readonly waitForRecordedBackend: typeof waitForRecordedBackend;
  readonly withCliContext: typeof withCliContext;
}

const defaultDependencies: OpenCliDependencies = {
  graphicalSessionAvailable: hasGraphicalSession,
  openExternalUrl,
  connectToRecordedBackend,
  waitForRecordedBackend,
  withCliContext,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resolveOpenDirectory(directory?: string): string {
  const resolved = path.resolve(directory?.trim() || process.cwd());
  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch (error) {
    throw new Error(`Directory does not exist: ${resolved}`, { cause: error });
  }
  if (!stats.isDirectory()) {
    throw new Error(`Path is not a directory: ${resolved}`);
  }
  return resolved;
}

export function desktopProjectUrl(projectId?: string): string {
  const scheme = process.env.SHIORICODE_DESKTOP_SCHEME?.trim() || "shioricode";
  const url = new URL(`${scheme}://app/index.html`);
  if (projectId) {
    url.hash = `/?project=${encodeURIComponent(projectId)}`;
  }
  return url.toString();
}

export function browserProjectUrl(httpUrl: string, projectId: string): string {
  const url = new URL(httpUrl);
  url.pathname = "/";
  url.searchParams.set("project", projectId);
  return url.toString();
}

export function hasGraphicalSession(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform !== "linux") {
    return true;
  }
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY || env.MIR_SOCKET);
}

export function resolveUrlOpener(
  url: string,
  platform = process.platform,
): { readonly command: string; readonly args: readonly string[] } {
  switch (platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  if (!hasGraphicalSession()) {
    throw new Error("No graphical desktop session is available.");
  }
  const opener = resolveUrlOpener(url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(opener.command, [...opener.args], {
      stdio: "ignore",
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${opener.command} timed out while opening the URL.`));
    }, URL_OPENER_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${opener.command} could not open the URL (${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}).`,
        ),
      );
    });
  });
}

async function addProjectToDesktop(
  connection: RecordedBackendConnection,
  directory: string,
): Promise<string> {
  try {
    const snapshot = await connection.rpc.orchestration.getSnapshot();
    return await ensureProjectForCwd(connection.rpc, snapshot, directory);
  } finally {
    await connection.rpc.dispose();
  }
}

export async function openShioriCodeDirectory(
  input: { readonly directory?: string; readonly baseDir?: string },
  dependencies: OpenCliDependencies = defaultDependencies,
): Promise<OpenShioriCodeResult> {
  const directory = resolveOpenDirectory(input.directory);
  const baseDir = resolveCliBaseDir(input.baseDir);
  let desktopError: unknown = new Error("ShioriCode Desktop is unavailable.");
  let existing = await dependencies.connectToRecordedBackend(baseDir);

  if (existing?.record.launcher === "desktop") {
    try {
      const projectId = await addProjectToDesktop(existing, directory);
      const url = desktopProjectUrl(projectId);
      await dependencies.openExternalUrl(url);
      return { directory, target: "desktop", url };
    } catch (error) {
      desktopError = error;
      existing = null;
    }
  } else if (existing) {
    desktopError = new Error(
      "A local ShioriCode web service already owns this data directory, so Desktop was not started concurrently.",
    );
    await existing.rpc.dispose();
  } else if (dependencies.graphicalSessionAvailable()) {
    try {
      await dependencies.openExternalUrl(desktopProjectUrl());
      const desktop = await dependencies.waitForRecordedBackend(baseDir, {
        launcher: "desktop",
        timeoutMs: DESKTOP_START_TIMEOUT_MS,
      });
      if (!desktop) {
        throw new Error("ShioriCode Desktop did not become ready.");
      }
      const projectId = await addProjectToDesktop(desktop, directory);
      const url = desktopProjectUrl(projectId);
      await dependencies.openExternalUrl(url);
      return { directory, target: "desktop", url };
    } catch (error) {
      desktopError = error;
    }
  } else {
    desktopError = new Error("No graphical desktop session is available.");
  }

  if (!dependencies.graphicalSessionAvailable()) {
    throw new Error(
      [
        `Could not open ${directory} in ShioriCode.`,
        `Desktop: ${errorMessage(desktopError)}`,
        "Browser: No graphical desktop session is available.",
        "On a headless server, connect from ShioriCode Desktop or mobile using ShioriCode Link instead.",
      ].join("\n"),
    );
  }

  try {
    return await dependencies.withCliContext({ baseDir }, async ({ rpc, snapshot }) => {
      const projectId = await ensureProjectForCwd(rpc, snapshot, directory);
      const url = browserProjectUrl(await resolveHttpUrl(baseDir), projectId);
      await dependencies.openExternalUrl(url);
      return { directory, target: "browser" as const, url };
    });
  } catch (browserError) {
    throw new Error(
      [
        `Could not open ${directory} in ShioriCode.`,
        `Desktop: ${errorMessage(desktopError)}`,
        `Browser: ${errorMessage(browserError)}`,
        "On a headless server, connect from ShioriCode Desktop or mobile using ShioriCode Link instead.",
      ].join("\n"),
      { cause: browserError },
    );
  }
}
