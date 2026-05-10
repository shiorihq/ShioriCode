import type {
  ApprovalRequestId,
  ProviderItemId,
  ProviderRequestKind,
  ThreadId,
  TurnId,
} from "contracts";

import type { JsonRpcResponse } from "./codexJsonRpc";

export type PendingRequestKey = string;

export interface PendingRequest {
  method: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface PendingApprovalRequest {
  requestId: ApprovalRequestId;
  jsonRpcId: string | number;
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "item/fileRead/requestApproval"
    | "permissions/requestApproval";
  requestKind: ProviderRequestKind;
  threadId: ThreadId;
  turnId?: TurnId;
  itemId?: ProviderItemId;
}

export interface PendingUserInputRequest {
  requestId: ApprovalRequestId;
  jsonRpcId: string | number;
  threadId: ThreadId;
  turnId?: TurnId;
  itemId?: ProviderItemId;
  requestMethod?:
    | "item/tool/requestUserInput"
    | "tool/requestUserInput"
    | "mcpServer/elicitation/request";
}

export interface CodexRequestTrackerState {
  pending: Map<PendingRequestKey, PendingRequest>;
  pendingApprovals: Map<ApprovalRequestId, PendingApprovalRequest>;
  pendingUserInputs: Map<ApprovalRequestId, PendingUserInputRequest>;
  nextRequestId: number;
}

export function createCodexRequestTrackerState(): CodexRequestTrackerState {
  return {
    pending: new Map(),
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    nextRequestId: 1,
  };
}

export async function trackCodexRequest<TResponse>(
  state: CodexRequestTrackerState,
  input: {
    method: string;
    params: unknown;
    timeoutMs?: number;
    writeMessage: (message: unknown) => void;
  },
): Promise<TResponse> {
  const id = state.nextRequestId;
  state.nextRequestId += 1;

  const result = await new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.pending.delete(String(id));
      reject(new Error(`Timed out waiting for ${input.method}.`));
    }, input.timeoutMs ?? 20_000);

    state.pending.set(String(id), {
      method: input.method,
      timeout,
      resolve,
      reject,
    });

    input.writeMessage({
      method: input.method,
      id,
      params: input.params,
    });
  });

  return result as TResponse;
}

export function resolveCodexResponse(
  state: CodexRequestTrackerState,
  response: JsonRpcResponse,
): boolean {
  const key = String(response.id);
  const pending = state.pending.get(key);
  if (!pending) {
    return false;
  }

  clearTimeout(pending.timeout);
  state.pending.delete(key);

  if (response.error?.message) {
    pending.reject(new Error(`${pending.method} failed: ${String(response.error.message)}`));
    return true;
  }

  pending.resolve(response.result);
  return true;
}

export function clearCodexPendingRequests(state: CodexRequestTrackerState, message: string): void {
  for (const pending of state.pending.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(message));
  }

  state.pending.clear();
  state.pendingApprovals.clear();
  state.pendingUserInputs.clear();
}
