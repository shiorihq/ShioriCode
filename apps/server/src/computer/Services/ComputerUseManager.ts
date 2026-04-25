import type {
  ComputerUseActionResult,
  ComputerUseClickInput,
  ComputerUseCloseSessionInput,
  ComputerUseKeyInput,
  ComputerUseMoveInput,
  ComputerUsePermissionsSnapshot,
  ComputerUseScreenshotInput,
  ComputerUseScreenshotResult,
  ComputerUseScrollInput,
  ComputerUseSessionSnapshot,
  ComputerUseTypeInput,
} from "contracts";
import { ComputerUseError } from "contracts";
import { Effect, ServiceMap } from "effect";

export interface ComputerUseManagerShape {
  readonly getPermissions: Effect.Effect<ComputerUsePermissionsSnapshot, ComputerUseError>;
  readonly createSession: Effect.Effect<ComputerUseSessionSnapshot, ComputerUseError>;
  readonly closeSession: (
    input: ComputerUseCloseSessionInput,
  ) => Effect.Effect<void, ComputerUseError>;
  readonly screenshot: (
    input: ComputerUseScreenshotInput,
  ) => Effect.Effect<ComputerUseScreenshotResult, ComputerUseError>;
  readonly click: (
    input: ComputerUseClickInput,
  ) => Effect.Effect<ComputerUseActionResult, ComputerUseError>;
  readonly move: (
    input: ComputerUseMoveInput,
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
}

export class ComputerUseManager extends ServiceMap.Service<
  ComputerUseManager,
  ComputerUseManagerShape
>()("shiori/computer/Services/ComputerUseManager") {}
