import { existsSync, readdirSync, statSync, watch, type WatchEventType } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { FileChange, FileChangeKind } from "../types.js";
import { Trigger, TriggerContext } from "./triggers.js";

export function every(
  intervalSeconds: number,
  callback: (ctx: TriggerContext) => Promise<void>,
): Trigger {
  if (intervalSeconds <= 0) {
    throw new Error(`interval_seconds must be positive, got ${intervalSeconds}`);
  }
  const fn: Trigger = async (ctx) => {
    while (!ctx.signal.aborted) {
      await Bun.sleep(intervalSeconds * 1000);
      if (ctx.signal.aborted) {
        return;
      }
      await callback(ctx);
    }
  };
  Object.defineProperty(fn, "name", { value: `every_${intervalSeconds}s` });
  Object.defineProperty(fn, "__doc__", {
    value: `Interval trigger: runs every ${intervalSeconds}s.`,
  });
  return fn;
}

export function onFileChange(
  path: string,
  callback: (ctx: TriggerContext, changes: readonly FileChange[]) => Promise<void>,
): Trigger {
  const displayPath = path;
  const watchPath = resolve(path);
  const fn: Trigger = async (ctx) => {
    const isDirectory = isDirectoryPath(watchPath);
    const knownPaths = collectKnownPaths(watchPath);
    const pending = new Map<string, FileChange>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let callbackQueue = Promise.resolve();
    let settled = false;

    let resolveDone!: () => void;
    let rejectDone!: (error: unknown) => void;
    const done = new Promise<void>((resolveDoneParam, rejectDoneParam) => {
      resolveDone = resolveDoneParam;
      rejectDone = rejectDoneParam;
    });

    const watcher = watchPathWithFallback(watchPath, isDirectory, (event, filename) => {
      const changedPath = normalizeChangedPath(watchPath, isDirectory, filename);
      const kind = classifyChange(event, changedPath, knownPaths);
      pending.set(changedPath, new FileChange({ kind, path: changedPath }));
      scheduleFlush();
    });

    watcher.on("error", (error) => {
      finishWithError(error);
    });

    const abort = () => {
      finish();
    };
    ctx.signal.addEventListener("abort", abort, { once: true });

    if (ctx.signal.aborted) {
      finish();
    }

    function scheduleFlush(): void {
      if (flushTimer !== undefined) {
        return;
      }
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        const changes = [...pending.values()];
        pending.clear();
        if (!changes.length || settled) {
          return;
        }
        callbackQueue = callbackQueue
          .then(() => callback(ctx, changes))
          .catch((error) => {
            finishWithError(error);
          });
      }, 25);
    }

    function finish(): void {
      if (settled) {
        return;
      }
      settled = true;
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
      }
      watcher.close();
      resolveDone();
    }

    function finishWithError(error: unknown): void {
      if (settled) {
        return;
      }
      settled = true;
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
      }
      watcher.close();
      rejectDone(error);
    }

    try {
      await done;
    } finally {
      ctx.signal.removeEventListener("abort", abort);
    }
  };
  Object.defineProperty(fn, "name", {
    value: `on_file_change_${basename(watchPath)}`,
  });
  Object.defineProperty(fn, "__doc__", {
    value: `File watcher trigger for ${displayPath}.`,
  });
  return fn;
}

export const on_file_change: typeof onFileChange = onFileChange;

export { FileChange, FileChangeKind };

function watchPathWithFallback(
  path: string,
  isDirectory: boolean,
  listener: (event: WatchEventType, filename: string | Buffer | null) => void,
) {
  try {
    return watch(path, { persistent: false, recursive: isDirectory }, listener);
  } catch (error) {
    if (!isDirectory) {
      throw error;
    }
    return watch(path, { persistent: false }, listener);
  }
}

function normalizeChangedPath(
  watchPath: string,
  isDirectory: boolean,
  filename: string | Buffer | null,
): string {
  if (!isDirectory || filename === null) {
    return watchPath;
  }
  return resolve(watchPath, filename.toString());
}

function classifyChange(
  event: WatchEventType,
  path: string,
  knownPaths: Set<string>,
): FileChangeKind {
  if (event !== "rename") {
    if (existsSync(path)) {
      addKnownPath(path, knownPaths);
    }
    return FileChangeKind.MODIFIED;
  }

  const existedBefore = knownPaths.has(path);
  const existsNow = existsSync(path);

  if (existsNow) {
    addKnownPath(path, knownPaths);
  } else {
    removeKnownPath(path, knownPaths);
  }

  if (existsNow && !existedBefore) {
    return FileChangeKind.ADDED;
  }
  if (!existsNow && existedBefore) {
    return FileChangeKind.DELETED;
  }
  return FileChangeKind.MODIFIED;
}

function isDirectoryPath(path: string): boolean {
  return statSync(path).isDirectory();
}

function collectKnownPaths(path: string): Set<string> {
  const paths = new Set<string>();
  addKnownPath(path, paths);
  return paths;
}

function addKnownPath(path: string, paths: Set<string>): void {
  if (!existsSync(path)) {
    return;
  }
  paths.add(path);
  if (!isDirectoryPath(path)) {
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    addKnownPath(join(path, entry.name), paths);
  }
}

function removeKnownPath(path: string, paths: Set<string>): void {
  const childPrefix = path.endsWith(sep) ? path : `${path}${sep}`;
  for (const knownPath of [...paths]) {
    if (knownPath === path || knownPath.startsWith(childPrefix)) {
      paths.delete(knownPath);
    }
  }
}
