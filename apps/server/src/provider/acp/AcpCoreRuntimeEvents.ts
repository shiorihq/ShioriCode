import {
  type RuntimeEventRawSource,
  RuntimeItemId,
  type CanonicalRequestType,
  type EventId,
  type ProviderApprovalDecision,
  type ProviderKind,
  type ProviderRuntimeEvent,
  type RuntimeRequestId,
  type ThreadTokenUsageSnapshot,
  type ThreadId,
  type ToolLifecycleItemType,
  type TurnId,
} from "contracts";

import type { AcpPermissionRequest, AcpPlanUpdate, AcpToolCallState } from "./AcpRuntimeModel.ts";

type AcpAdapterRawSource = Extract<
  RuntimeEventRawSource,
  "acp.jsonrpc" | `acp.${string}.extension`
>;

interface AcpEventStamp {
  readonly eventId: EventId;
  readonly createdAt: string;
}

type AcpCanonicalRequestType = Extract<
  CanonicalRequestType,
  "exec_command_approval" | "file_read_approval" | "file_change_approval" | "unknown"
>;

function canonicalRequestTypeFromAcpKind(kind: string | "unknown"): AcpCanonicalRequestType {
  switch (kind) {
    case "execute":
      return "exec_command_approval";
    case "read":
      return "file_read_approval";
    case "edit":
    case "delete":
    case "move":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function normalizedSearchText(value: string | undefined): string {
  return (value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function acpToolText(toolCall: AcpToolCallState): string {
  return [
    toolCall.kind,
    toolCall.title,
    toolCall.detail,
    typeof toolCall.data.title === "string" ? toolCall.data.title : undefined,
    typeof toolCall.data.toolName === "string" ? toolCall.data.toolName : undefined,
  ]
    .map(normalizedSearchText)
    .filter((value) => value.length > 0)
    .join(" ");
}

function isMcpAcpToolCall(toolCall: AcpToolCallState): boolean {
  const text = acpToolText(toolCall);
  return text.includes("mcp server") || text.startsWith("mcp ") || text.includes(" mcp ");
}

function isWebSearchAcpToolCall(toolCall: AcpToolCallState): boolean {
  if (toolCall.kind === "fetch") {
    return true;
  }
  if (toolCall.kind !== "search") {
    return false;
  }
  const text = acpToolText(toolCall);
  return (
    text.includes("web search") ||
    text.includes("searching the web") ||
    text.includes("google search")
  );
}

function isSubagentAcpToolCall(toolCall: AcpToolCallState): boolean {
  const text = acpToolText(toolCall);
  return text.includes("subagent") || text.includes("sub agent") || /\bagent\b/.test(text);
}

function canonicalItemTypeFromAcpToolCall(toolCall: AcpToolCallState): ToolLifecycleItemType {
  if (isMcpAcpToolCall(toolCall)) {
    return "mcp_tool_call";
  }

  switch (toolCall.kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "fetch":
      return "web_search";
    case "search":
      return isWebSearchAcpToolCall(toolCall) ? "web_search" : "dynamic_tool_call";
    case "think":
      return isSubagentAcpToolCall(toolCall) ? "collab_agent_tool_call" : "dynamic_tool_call";
    default:
      return "dynamic_tool_call";
  }
}

function runtimeItemStatusFromAcpToolStatus(
  status: AcpToolCallState["status"],
): "inProgress" | "completed" | "failed" | undefined {
  switch (status) {
    case "pending":
    case "inProgress":
      return "inProgress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}

export function makeAcpRequestOpenedEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly requestId: RuntimeRequestId;
  readonly permissionRequest: AcpPermissionRequest;
  readonly detail: string;
  readonly args: unknown;
  readonly source: AcpAdapterRawSource;
  readonly method: string;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "request.opened",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    requestId: input.requestId,
    payload: {
      requestType: canonicalRequestTypeFromAcpKind(input.permissionRequest.kind),
      detail: input.detail,
      args: input.args,
    },
    raw: {
      source: input.source,
      method: input.method,
      payload: input.rawPayload,
    },
  };
}

export function makeAcpRequestResolvedEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly requestId: RuntimeRequestId;
  readonly permissionRequest: AcpPermissionRequest;
  readonly decision: ProviderApprovalDecision;
}): ProviderRuntimeEvent {
  return {
    type: "request.resolved",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    requestId: input.requestId,
    payload: {
      requestType: canonicalRequestTypeFromAcpKind(input.permissionRequest.kind),
      decision: typeof input.decision === "string" ? input.decision : "decline",
      ...(typeof input.decision === "string" ? {} : { resolution: input.decision }),
    },
  };
}

export function makeAcpPlanUpdatedEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly payload: AcpPlanUpdate;
  readonly source: AcpAdapterRawSource;
  readonly method: string;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "turn.plan.updated",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    payload: input.payload,
    raw: {
      source: input.source,
      method: input.method,
      payload: input.rawPayload,
    },
  };
}

export function makeAcpToolCallEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly toolCall: AcpToolCallState;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  const runtimeStatus = runtimeItemStatusFromAcpToolStatus(input.toolCall.status);
  return {
    type:
      input.toolCall.status === "completed" || input.toolCall.status === "failed"
        ? "item.completed"
        : "item.updated",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    itemId: RuntimeItemId.makeUnsafe(input.toolCall.toolCallId),
    payload: {
      itemType: canonicalItemTypeFromAcpToolCall(input.toolCall),
      ...(runtimeStatus ? { status: runtimeStatus } : {}),
      ...(input.toolCall.title ? { title: input.toolCall.title } : {}),
      ...(input.toolCall.detail ? { detail: input.toolCall.detail } : {}),
      ...(Object.keys(input.toolCall.data).length > 0 ? { data: input.toolCall.data } : {}),
    },
    raw: {
      source: "acp.jsonrpc",
      method: "session/update",
      payload: input.rawPayload,
    },
  };
}

export function makeAcpAssistantItemEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId: string;
  readonly lifecycle: "item.started" | "item.completed";
}): ProviderRuntimeEvent {
  return {
    type: input.lifecycle,
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    itemId: RuntimeItemId.makeUnsafe(input.itemId),
    payload: {
      itemType: "assistant_message",
      status: input.lifecycle === "item.completed" ? "completed" : "inProgress",
    },
  };
}

export function makeAcpContentDeltaEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string;
  readonly text: string;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "content.delta",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: RuntimeItemId.makeUnsafe(input.itemId) } : {}),
    payload: {
      streamKind: "assistant_text",
      delta: input.text,
    },
    raw: {
      source: "acp.jsonrpc",
      method: "session/update",
      payload: input.rawPayload,
    },
  };
}

export function makeAcpUsageUpdatedEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly usage: ThreadTokenUsageSnapshot;
  readonly source: AcpAdapterRawSource;
  readonly method: string;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "thread.token-usage.updated",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    payload: {
      usage: input.usage,
    },
    raw: {
      source: input.source,
      method: input.method,
      payload: input.rawPayload,
    },
  };
}
