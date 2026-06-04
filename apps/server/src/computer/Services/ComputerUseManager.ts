import type {
  ComputerUseActionResult,
  ComputerUseAppStateResult,
  ComputerUseClickInput,
  ComputerUseCloseSessionInput,
  ComputerUseDoubleClickInput,
  ComputerUseDragInput,
  ComputerUseFocusAppInput,
  ComputerUseFocusWindowInput,
  ComputerUseKeyInput,
  ComputerUseListAppsInput,
  ComputerUseMoveInput,
  ComputerUsePermissionActionInput,
  ComputerUsePermissionActionResult,
  ComputerUsePermissionsSnapshot,
  ComputerUseRightClickInput,
  ComputerUseScreenshotInput,
  ComputerUseScreenshotResult,
  ComputerUseScrollInput,
  ComputerUseSessionSnapshot,
  ComputerUseTypeInput,
  ComputerUseWaitInput,
} from "contracts";
import { ComputerUseError } from "contracts";
import { Effect, ServiceMap } from "effect";

export interface ComputerUseManagerShape {
  readonly getPermissions: Effect.Effect<ComputerUsePermissionsSnapshot, ComputerUseError>;
  readonly requestPermission: (
    input: ComputerUsePermissionActionInput,
  ) => Effect.Effect<ComputerUsePermissionActionResult, ComputerUseError>;
  readonly showPermissionGuide: (
    input: ComputerUsePermissionActionInput,
  ) => Effect.Effect<ComputerUsePermissionActionResult, ComputerUseError>;
  readonly createSession: Effect.Effect<ComputerUseSessionSnapshot, ComputerUseError>;
  readonly closeSession: (
    input: ComputerUseCloseSessionInput,
  ) => Effect.Effect<void, ComputerUseError>;
  readonly screenshot: (
    input: ComputerUseScreenshotInput,
  ) => Effect.Effect<ComputerUseScreenshotResult, ComputerUseError>;
  readonly listApps: (
    input: ComputerUseListAppsInput,
  ) => Effect.Effect<ComputerUseAppStateResult, ComputerUseError>;
  readonly focusApp: (
    input: ComputerUseFocusAppInput,
  ) => Effect.Effect<ComputerUseActionResult, ComputerUseError>;
  readonly focusWindow: (
    input: ComputerUseFocusWindowInput,
  ) => Effect.Effect<ComputerUseActionResult, ComputerUseError>;
  readonly click: (
    input: ComputerUseClickInput,
  ) => Effect.Effect<ComputerUseActionResult, ComputerUseError>;
  readonly doubleClick: (
    input: ComputerUseDoubleClickInput,
  ) => Effect.Effect<ComputerUseActionResult, ComputerUseError>;
  readonly rightClick: (
    input: ComputerUseRightClickInput,
  ) => Effect.Effect<ComputerUseActionResult, ComputerUseError>;
  readonly move: (
    input: ComputerUseMoveInput,
  ) => Effect.Effect<ComputerUseActionResult, ComputerUseError>;
  readonly drag: (
    input: ComputerUseDragInput,
  ) => Effect.Effect<ComputerUseActionResult, ComputerUseError>;
  readonly type: (
    input: ComputerUseTypeInput,
  ) => Effect.Effect<ComputerUseActionResult, ComputerUseError>;
  readonly key: (
    input: ComputerUseKeyInput,
  ) => Effect.Effect<ComputerUseActionResult, ComputerUseError>;
  readonly scroll: (
    input: ComputerUseScrollInput,
  ) => Effect.Effect<ComputerUseActionResult, ComputerUseError>;
  readonly wait: (
    input: ComputerUseWaitInput,
  ) => Effect.Effect<ComputerUseActionResult, ComputerUseError>;
}

export class ComputerUseManager extends ServiceMap.Service<
  ComputerUseManager,
  ComputerUseManagerShape
>()("shiori/computer/Services/ComputerUseManager") {}
