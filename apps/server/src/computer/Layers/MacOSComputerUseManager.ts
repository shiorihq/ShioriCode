import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  type ComputerUseActionResult,
  type ComputerUseAppStateResult,
  type ComputerUsePermissionSubject,
  type ComputerUseClickInput,
  type ComputerUseCloseSessionInput,
  type ComputerUseDoubleClickInput,
  type ComputerUseDragInput,
  ComputerUseError,
  type ComputerUseFocusAppInput,
  type ComputerUseFocusWindowInput,
  type ComputerUseKeyInput,
  type ComputerUseListAppsInput,
  type ComputerUseMoveInput,
  type ComputerUsePermissionActionInput,
  type ComputerUsePermissionActionResult,
  type ComputerUsePermissionsSnapshot,
  type ComputerUseRightClickInput,
  type ComputerUseScreenshotInput,
  type ComputerUseScreenshotResult,
  type ComputerUseScrollInput,
  type ComputerUseSessionId,
  type ComputerUseSessionSnapshot,
  type ComputerUseTypeInput,
  type ComputerUseWaitInput,
} from "contracts";
import { Effect, Layer, Ref } from "effect";

import { ServerSettingsService } from "../../serverSettings";
import { runProcess } from "../../processRunner";
import {
  computerUseHelperCandidatesFor,
  computerUsePermissionSubjectForHelperPath,
  processResourcesPath,
  resolveAppRootFromModule,
} from "../helperResolver";
import { enrichComputerPermissionGuideInput } from "../permissionInput";
import { ComputerUseManager } from "../Services/ComputerUseManager";
import {
  enrichScreenshotCoordinateInput,
  screenshotSizeFromResult,
  type ScreenshotSize,
} from "../screenshotCoordinates";

const DEFAULT_APP_ROOT = resolveAppRootFromModule(import.meta.url);
const DEFAULT_HELPER_PACKAGE_PATH = path.join(
  DEFAULT_APP_ROOT,
  "apps/desktop/native/ShioriComputerUse",
);
const HELPER_TIMEOUT_MS = 30_000;
const HELPER_STDOUT_LIMIT_BYTES = 32 * 1024 * 1024;
const SCREENSHOT_COORDINATE_COMMANDS = new Set(["click", "move", "drag", "scroll"]);

type ComputerUseErrorCode =
  | "unsupported"
  | "disabled"
  | "helperUnavailable"
  | "permissionDenied"
  | "sessionNotFound"
  | "actionFailed";

interface HelperErrorPayload {
  readonly error?: string;
  readonly code?: ComputerUseErrorCode;
}

interface HelperResolveState {
  readonly path: string | null;
  readonly buildAttempted: boolean;
  readonly lastError: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function unsupportedSnapshot(input: {
  readonly message: string;
  readonly supported?: boolean;
  readonly helperPath?: string | null;
  readonly permissionSubject?: ComputerUsePermissionSubject | null;
}): ComputerUsePermissionsSnapshot {
  const helperPath = input.helperPath ?? null;
  const permissionSubject =
    input.permissionSubject === null
      ? undefined
      : (input.permissionSubject ?? computerUsePermissionSubjectForHelperPath(helperPath));
  return {
    platform: process.platform,
    supported: input.supported ?? false,
    helperAvailable: helperPath !== null,
    helperPath,
    ...(permissionSubject ? { permissionSubject } : {}),
    checkedAt: nowIso(),
    message: input.message,
    permissions: [
      {
        kind: "accessibility",
        label: "Accessibility",
        state: "unsupported",
        detail: input.message,
      },
      {
        kind: "screen-recording",
        label: "Screen Recording",
        state: "unsupported",
        detail: input.message,
      },
    ],
  };
}

function readHelperPathFromEnv(): string | null {
  const configured = process.env.SHIORICODE_COMPUTER_USE_HELPER_BINARY?.trim();
  if (configured && existsSync(configured)) {
    return configured;
  }
  return null;
}

function existingCandidatePath(): string | null {
  const envPath = readHelperPathFromEnv();
  if (envPath) return envPath;
  for (const candidate of computerUseHelperCandidatesFor({
    appRoot: DEFAULT_APP_ROOT,
    configured: null,
    packagePath: process.env.SHIORICODE_COMPUTER_USE_HELPER_PACKAGE_PATH ?? null,
    resourcesPath: processResourcesPath(),
  })) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function buildDevelopmentHelper(): Promise<string | null> {
  const packagePath =
    process.env.SHIORICODE_COMPUTER_USE_HELPER_PACKAGE_PATH?.trim() || DEFAULT_HELPER_PACKAGE_PATH;
  if (!existsSync(path.join(packagePath, "Package.swift"))) {
    return null;
  }
  await runProcess("swift", ["build", "-c", "debug", "--product", "ShioriComputerUseHelper"], {
    cwd: packagePath,
    timeoutMs: 180_000,
    maxBufferBytes: 2 * 1024 * 1024,
  });
  const builtPath = path.join(packagePath, ".build/debug/ShioriComputerUseHelper");
  return existsSync(builtPath) ? builtPath : null;
}

function normalizeUnknownError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return String(error);
}

function parseHelperError(stdout: string, stderr: string): HelperErrorPayload | null {
  const combined = `${stdout}\n${stderr}`.trim();
  if (!combined) return null;
  const lastLine = combined
    .split(/\r?\n/g)
    .toReversed()
    .find((line) => line.trim().startsWith("{"));
  if (!lastLine) return { error: combined };
  try {
    const parsed = JSON.parse(lastLine) as HelperErrorPayload;
    return parsed;
  } catch {
    return { error: combined };
  }
}

function helperError(input: {
  readonly fallbackMessage: string;
  readonly payload?: HelperErrorPayload | null;
  readonly cause?: unknown;
}): ComputerUseError {
  const message =
    input.payload?.error?.trim() ||
    (input.cause ? normalizeUnknownError(input.cause) : "") ||
    input.fallbackMessage;
  return new ComputerUseError({
    code: input.payload?.code ?? "actionFailed",
    message,
    ...(input.cause !== undefined ? { cause: input.cause } : {}),
  });
}

export const ComputerUseManagerLive = Layer.effect(
  ComputerUseManager,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const sessionsRef = yield* Ref.make(new Map<string, ComputerUseSessionSnapshot>());
    const latestScreenshotSizesRef = yield* Ref.make(new Map<string, ScreenshotSize>());
    const helperRef = yield* Ref.make<HelperResolveState>({
      path: null,
      buildAttempted: false,
      lastError: null,
    });

    const resolveHelperPath = Effect.fn("computer.resolveHelperPath")(function* () {
      if (process.platform !== "darwin") {
        return yield* Effect.fail(
          new ComputerUseError({
            code: "unsupported",
            message: "Computer Use is currently only supported on macOS.",
          }),
        );
      }

      const state = yield* Ref.get(helperRef);
      if (state.path && existsSync(state.path)) {
        return state.path;
      }

      const existing = existingCandidatePath();
      if (existing) {
        yield* Ref.update(helperRef, (current) => ({
          ...current,
          path: existing,
          lastError: null,
        }));
        return existing;
      }

      if (state.buildAttempted) {
        return yield* Effect.fail(
          new ComputerUseError({
            code: "helperUnavailable",
            message:
              state.lastError ??
              "The macOS Computer Use helper is unavailable. Build the desktop native helper first.",
          }),
        );
      }

      const built = yield* Effect.tryPromise({
        try: buildDevelopmentHelper,
        catch: (cause) =>
          new ComputerUseError({
            code: "helperUnavailable",
            message: normalizeUnknownError(cause),
            cause,
          }),
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const message = error.message;
            yield* Ref.set(helperRef, {
              path: null,
              buildAttempted: true,
              lastError: message,
            });
            return yield* Effect.fail(
              new ComputerUseError({
                code: "helperUnavailable",
                message,
                cause: error.cause ?? error,
              }),
            );
          }),
        ),
      );

      if (!built) {
        yield* Ref.set(helperRef, {
          path: null,
          buildAttempted: true,
          lastError: "The macOS Computer Use helper package was not found.",
        });
        return yield* Effect.fail(
          new ComputerUseError({
            code: "helperUnavailable",
            message: "The macOS Computer Use helper package was not found.",
          }),
        );
      }

      yield* Ref.set(helperRef, { path: built, buildAttempted: true, lastError: null });
      return built;
    });

    const runHelper = Effect.fn("computer.runHelper")(function* <A>(
      command: string,
      input: unknown,
      fallbackMessage: string,
    ) {
      const helperPath = yield* resolveHelperPath();
      const result = yield* Effect.tryPromise({
        try: () =>
          runProcess(helperPath, [command], {
            stdin: JSON.stringify(input ?? {}),
            timeoutMs: HELPER_TIMEOUT_MS,
            allowNonZeroExit: true,
            maxBufferBytes: HELPER_STDOUT_LIMIT_BYTES,
            outputMode: "truncate",
          }),
        catch: (cause) =>
          new ComputerUseError({
            code: "actionFailed",
            message: normalizeUnknownError(cause),
            cause,
          }),
      });

      if (result.code !== 0 || result.timedOut) {
        return yield* Effect.fail(
          helperError({
            fallbackMessage,
            payload: parseHelperError(result.stdout, result.stderr),
          }),
        );
      }

      try {
        return JSON.parse(result.stdout.trim()) as A;
      } catch (cause) {
        return yield* Effect.fail(
          helperError({
            fallbackMessage: "The Computer Use helper returned invalid JSON.",
            cause,
          }),
        );
      }
    });

    const ensureEnabled = Effect.fn("computer.ensureEnabled")(function* () {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new ComputerUseError({
              code: "actionFailed",
              message: "Failed to read Computer Use settings.",
              cause,
            }),
        ),
      );
      if (!settings.computerUse.enabled) {
        return yield* Effect.fail(
          new ComputerUseError({
            code: "disabled",
            message: "Computer Use is disabled in ShioriCode settings.",
          }),
        );
      }
      return settings;
    });

    const getPermissions = Effect.gen(function* () {
      if (process.platform !== "darwin") {
        return unsupportedSnapshot({
          message: "Computer Use is currently only supported on macOS.",
          permissionSubject: null,
        });
      }
      const helperAvailable = yield* resolveHelperPath().pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (!helperAvailable) {
        const state = yield* Ref.get(helperRef);
        return unsupportedSnapshot({
          message: state.lastError ?? "The macOS Computer Use helper is unavailable.",
          supported: true,
        });
      }
      return yield* runHelper<ComputerUsePermissionsSnapshot>(
        "permissions",
        {},
        "Failed to read macOS Computer Use permissions.",
      );
    });

    const makeSession = (id: string): ComputerUseSessionSnapshot => ({
      id: id as ComputerUseSessionId,
      kind: "macos-desktop",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    const resolveSession = Effect.fn("computer.resolveSession")(function* (
      sessionId: string | undefined,
    ) {
      const sessions = yield* Ref.get(sessionsRef);
      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) {
          return yield* Effect.fail(
            new ComputerUseError({
              code: "sessionNotFound",
              message: `Computer Use session '${sessionId}' does not exist.`,
            }),
          );
        }
        return existing;
      }
      const existingDefault = sessions.values().next().value as
        | ComputerUseSessionSnapshot
        | undefined;
      if (existingDefault) {
        return existingDefault;
      }
      const next = makeSession(`computer-${randomUUID()}`);
      yield* Ref.update(sessionsRef, (current) => new Map(current).set(next.id, next));
      return next;
    });

    const actionResult = Effect.fn("computer.actionResult")(function* (
      sessionId: string | undefined,
      command: string,
      input: Record<string, unknown>,
      fallbackMessage: string,
    ) {
      yield* ensureEnabled();
      const session = yield* resolveSession(sessionId);
      const latestScreenshotSizes = yield* Ref.get(latestScreenshotSizesRef);
      const actionInput = SCREENSHOT_COORDINATE_COMMANDS.has(command)
        ? enrichScreenshotCoordinateInput(input, latestScreenshotSizes.get(session.id))
        : input;
      return yield* runHelper<ComputerUseActionResult>(
        command,
        { ...actionInput, sessionId: session.id },
        fallbackMessage,
      );
    });

    return {
      getPermissions,
      requestPermission: (input: ComputerUsePermissionActionInput) =>
        runHelper<ComputerUsePermissionActionResult>(
          "request-permission",
          input,
          "Failed to request macOS Computer Use permission.",
        ),
      showPermissionGuide: (input: ComputerUsePermissionActionInput) =>
        runHelper<ComputerUsePermissionActionResult>(
          "permission-guide",
          enrichComputerPermissionGuideInput(input),
          "Failed to open macOS Computer Use permission settings.",
        ),
      createSession: Effect.gen(function* () {
        yield* ensureEnabled();
        const session = makeSession(`computer-${randomUUID()}`);
        yield* Ref.update(sessionsRef, (current) => new Map(current).set(session.id, session));
        return session;
      }),
      closeSession: (input: ComputerUseCloseSessionInput) =>
        Effect.gen(function* () {
          const sessions = yield* Ref.get(sessionsRef);
          if (!sessions.has(input.sessionId)) {
            return yield* Effect.fail(
              new ComputerUseError({
                code: "sessionNotFound",
                message: `Computer Use session '${input.sessionId}' does not exist.`,
              }),
            );
          }

          yield* Ref.update(sessionsRef, (current) => {
            const next = new Map(current);
            next.delete(input.sessionId);
            return next;
          });
          yield* Ref.update(latestScreenshotSizesRef, (current) => {
            const next = new Map(current);
            next.delete(input.sessionId);
            return next;
          });
        }),
      screenshot: (input: ComputerUseScreenshotInput) =>
        Effect.gen(function* () {
          yield* ensureEnabled();
          const session = yield* resolveSession(input.sessionId);
          const result = yield* runHelper<ComputerUseScreenshotResult>(
            "screenshot",
            { sessionId: session.id },
            "Failed to capture the macOS screen.",
          );
          const remembered = screenshotSizeFromResult(result, session.id);
          if (remembered) {
            yield* Ref.update(latestScreenshotSizesRef, (current) =>
              new Map(current).set(remembered.sessionId, remembered.size),
            );
          }
          return result;
        }),
      listApps: (input: ComputerUseListAppsInput) =>
        Effect.gen(function* () {
          yield* ensureEnabled();
          const session = yield* resolveSession(input.sessionId);
          return yield* runHelper<ComputerUseAppStateResult>(
            "list-apps",
            { sessionId: session.id },
            "Failed to list visible macOS applications.",
          );
        }),
      focusApp: (input: ComputerUseFocusAppInput) =>
        Effect.gen(function* () {
          yield* ensureEnabled();
          const session = yield* resolveSession(input.sessionId);
          return yield* runHelper<ComputerUseActionResult>(
            "focus-app",
            { ...input, sessionId: session.id },
            "Failed to focus a macOS application.",
          );
        }),
      focusWindow: (input: ComputerUseFocusWindowInput) =>
        Effect.gen(function* () {
          yield* ensureEnabled();
          const session = yield* resolveSession(input.sessionId);
          return yield* runHelper<ComputerUseActionResult>(
            "focus-window",
            { ...input, sessionId: session.id },
            "Failed to focus a macOS window.",
          );
        }),
      click: (input: ComputerUseClickInput) =>
        actionResult(input.sessionId, "click", input, "Failed to click the macOS desktop."),
      doubleClick: (input: ComputerUseDoubleClickInput) =>
        actionResult(
          input.sessionId,
          "click",
          { ...input, clickCount: 2 },
          "Failed to double-click the macOS desktop.",
        ),
      rightClick: (input: ComputerUseRightClickInput) =>
        actionResult(
          input.sessionId,
          "click",
          { ...input, button: "right" },
          "Failed to right-click the macOS desktop.",
        ),
      move: (input: ComputerUseMoveInput) =>
        actionResult(input.sessionId, "move", input, "Failed to move the macOS pointer."),
      drag: (input: ComputerUseDragInput) =>
        actionResult(input.sessionId, "drag", input, "Failed to drag the macOS pointer."),
      type: (input: ComputerUseTypeInput) =>
        actionResult(input.sessionId, "type", input, "Failed to type into the macOS desktop."),
      key: (input: ComputerUseKeyInput) =>
        actionResult(input.sessionId, "key", input, "Failed to press a macOS key."),
      scroll: (input: ComputerUseScrollInput) =>
        actionResult(input.sessionId, "scroll", input, "Failed to scroll the macOS desktop."),
      wait: (input: ComputerUseWaitInput) =>
        actionResult(input.sessionId, "wait", input, "Failed to wait for the macOS desktop."),
    };
  }),
);
