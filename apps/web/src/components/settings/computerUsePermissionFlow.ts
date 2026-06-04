import type {
  ComputerUsePermissionActionResult,
  ComputerUsePermissionKind,
  ComputerUsePermissionsSnapshot,
} from "contracts";

export const COMPUTER_USE_PERMISSION_RECHECK_DELAYS_MS = [
  750, 2_000, 5_000, 10_000, 20_000, 30_000,
] as const;

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

interface ComputerUsePermissionFlowHandlers {
  readonly requestPermission?: (input: {
    readonly kind: ComputerUsePermissionKind;
  }) => Promise<ComputerUsePermissionActionResult>;
  readonly showPermissionGuide?: (input: {
    readonly kind: ComputerUsePermissionKind;
  }) => Promise<ComputerUsePermissionActionResult>;
}

interface ComputerUsePermissionRecheckScheduleInput {
  readonly kind: ComputerUsePermissionKind;
  readonly delaysMs?: readonly number[];
  readonly refresh: () => Promise<ComputerUsePermissionsSnapshot>;
  readonly onGranted?: (snapshot: ComputerUsePermissionsSnapshot) => void;
  readonly onError?: (error: unknown) => void;
  readonly setTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly clearTimeout?: (handle: TimerHandle) => void;
}

export async function runComputerUsePermissionFlow(
  kind: ComputerUsePermissionKind,
  handlers: ComputerUsePermissionFlowHandlers,
): Promise<ComputerUsePermissionActionResult> {
  const requestResult = handlers.requestPermission
    ? await handlers.requestPermission({ kind })
    : undefined;
  if (requestResult?.ok) {
    return requestResult;
  }

  const guideResult = handlers.showPermissionGuide
    ? await handlers.showPermissionGuide({ kind })
    : undefined;
  return (
    guideResult ??
    requestResult ?? {
      ok: false,
      kind,
      message: "Computer Use permission guides are unavailable in this browser.",
    }
  );
}

export function isComputerUsePermissionGranted(
  snapshot: ComputerUsePermissionsSnapshot | null | undefined,
  kind: ComputerUsePermissionKind,
): boolean {
  return (
    snapshot?.permissions.some(
      (permission) => permission.kind === kind && permission.state === "granted",
    ) ?? false
  );
}

export function createComputerUsePermissionRecheckSchedule(
  input: ComputerUsePermissionRecheckScheduleInput,
): () => void {
  const setTimer = input.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const clearTimer = input.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  const delaysMs = input.delaysMs ?? COMPUTER_USE_PERMISSION_RECHECK_DELAYS_MS;
  const timers: TimerHandle[] = [];
  let cancelled = false;

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    for (const timer of timers.splice(0)) {
      clearTimer(timer);
    }
  };

  for (const delayMs of delaysMs) {
    timers.push(
      setTimer(() => {
        if (cancelled) return;
        void input
          .refresh()
          .then((snapshot) => {
            if (!isComputerUsePermissionGranted(snapshot, input.kind)) {
              return;
            }
            input.onGranted?.(snapshot);
            cancel();
          })
          .catch((error: unknown) => {
            input.onError?.(error);
          });
      }, delayMs),
    );
  }

  return cancel;
}
