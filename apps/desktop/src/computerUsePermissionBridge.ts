import type {
  ComputerUsePermissionActionInput,
  ComputerUsePermissionActionResult,
  ComputerUsePermissionKind,
} from "contracts";
import { computerUsePermissionSubjectForHelperPath } from "shared/computerUseHelper";

export { computerUsePermissionSubjectForHelperPath } from "shared/computerUseHelper";

export function normalizeComputerUsePermissionKind(rawKind: unknown): ComputerUsePermissionKind {
  if (rawKind === "accessibility" || rawKind === "screen-recording") {
    return rawKind;
  }
  const detail = typeof rawKind === "string" && rawKind.trim() ? ` '${rawKind.trim()}'` : "";
  throw new Error(
    `Unsupported Computer Use permission kind${detail}. Expected 'accessibility' or 'screen-recording'.`,
  );
}

export function normalizeComputerUsePermissionActionInput(
  rawInput: unknown,
): ComputerUsePermissionActionInput {
  if (rawInput && typeof rawInput === "object") {
    const record = rawInput as Record<string, unknown>;
    return {
      kind: normalizeComputerUsePermissionKind(record.kind),
      ...(typeof record.hostAppBundlePath === "string" && record.hostAppBundlePath.trim()
        ? { hostAppBundlePath: record.hostAppBundlePath.trim() }
        : {}),
      ...(typeof record.hostAppDisplayName === "string" && record.hostAppDisplayName.trim()
        ? { hostAppDisplayName: record.hostAppDisplayName.trim() }
        : {}),
      ...(typeof record.durationSeconds === "number" && Number.isFinite(record.durationSeconds)
        ? { durationSeconds: record.durationSeconds }
        : {}),
    };
  }
  return {
    kind: normalizeComputerUsePermissionKind(rawInput),
  };
}

export function computerUsePermissionFailureResult(input: {
  readonly kind: ComputerUsePermissionKind;
  readonly message: string;
  readonly helperPath?: string | null;
}): ComputerUsePermissionActionResult {
  return {
    ok: false,
    kind: input.kind,
    permissionSubject: computerUsePermissionSubjectForHelperPath(input.helperPath),
    message: input.message,
  };
}

function parseJsonObjectCandidate(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const jsonLine = trimmed
      .split(/\r?\n/g)
      .toReversed()
      .find((line) => line.trim().startsWith("{"));
    return jsonLine ? JSON.parse(jsonLine) : undefined;
  }
}

export function parseComputerUseHelperOutput<T>(stdout: string): T {
  if (stdout.trim().length === 0) {
    return {} as T;
  }
  const parsed = parseJsonObjectCandidate(stdout);
  if (parsed === undefined) {
    return JSON.parse(stdout) as T;
  }
  return parsed as T;
}

export function computerUseHelperError(result: {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly timedOut: boolean;
}): Error {
  for (const output of [result.stdout, result.stderr]) {
    try {
      const parsed = parseJsonObjectCandidate(output) as { error?: unknown } | undefined;
      if (typeof parsed?.error === "string" && parsed.error.trim()) {
        return new Error(parsed.error.trim());
      }
    } catch {
      // Use raw output below.
    }
  }

  if (result.timedOut) {
    return new Error("Computer Use helper timed out.");
  }

  const text = result.stdout.trim();
  const errorText = result.stderr.trim();
  return new Error(
    errorText || text || `Computer Use helper failed with code ${result.code ?? "null"}.`,
  );
}
