export interface ExtractChangedFilesOptions {
  readonly maxDepth?: number;
  readonly maxFiles?: number;
}

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_FILES = 12;

const FILE_PATH_KEYS = [
  "path",
  "filePath",
  "notebook_path",
  "notebookPath",
  "relativePath",
  "filename",
  "newPath",
  "oldPath",
] as const;

const NESTED_FILE_CHANGE_KEYS = [
  "item",
  "result",
  "input",
  "data",
  "changes",
  "files",
  "edits",
  "patch",
  "patches",
  "operations",
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown) {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(
  value: unknown,
  target: string[],
  seen: Set<string>,
  depth: number,
  maxDepth: number,
  maxFiles: number,
) {
  if (depth > maxDepth || target.length >= maxFiles) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1, maxDepth, maxFiles);
      if (target.length >= maxFiles) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  for (const key of FILE_PATH_KEYS) {
    pushChangedFile(target, seen, record[key]);
  }

  for (const nestedKey of NESTED_FILE_CHANGE_KEYS) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1, maxDepth, maxFiles);
    if (target.length >= maxFiles) {
      return;
    }
  }
}

export function extractChangedFilesFromProviderData(
  value: unknown,
  options: ExtractChangedFilesOptions = {},
): string[] {
  const changedFiles: string[] = [];
  const seen = new Set<string>();
  collectChangedFiles(
    value,
    changedFiles,
    seen,
    0,
    options.maxDepth ?? DEFAULT_MAX_DEPTH,
    options.maxFiles ?? DEFAULT_MAX_FILES,
  );
  return changedFiles;
}
