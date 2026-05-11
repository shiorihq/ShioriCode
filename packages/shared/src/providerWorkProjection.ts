import type {
  CanonicalItemType,
  EventId,
  ProviderRuntimeEvent,
  RuntimeContentStreamKind,
  RuntimeItemStatus,
  RuntimeTaskId,
  ThreadId,
  ToolLifecycleItemType,
  TurnId,
  TurnWorkContentStream,
  TurnWorkItem,
  TurnWorkItemKind,
  TurnWorkItemRefs,
  TurnWorkItemStatus,
  TurnWorkSnapshot,
} from "contracts";
import {
  extractStructuredProviderToolData,
  providerToolTitle,
  summarizeProviderToolInvocation,
} from "./providerTool";

export interface ProviderRuntimeWorkProjectionOptions {
  readonly turnId?: TurnId | undefined;
}

interface MutableProjectionState {
  readonly items: Map<string, TurnWorkItem>;
  readonly sourceEventIds: EventId[];
  nextOrder: number;
  updatedAt: string;
}

type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function mergeRefs(
  previous: TurnWorkItemRefs | undefined,
  next: TurnWorkItemRefs | undefined,
): TurnWorkItemRefs | undefined {
  if (!previous) return next;
  if (!next) return previous;
  const childThreadIds = [
    ...(previous.childThreadIds ?? []),
    ...(next.childThreadIds ?? []),
  ].filter((value, index, values) => values.indexOf(value) === index);
  return {
    ...previous,
    ...next,
    ...(childThreadIds.length > 0 ? { childThreadIds } : {}),
  };
}

function providerRefsFromRuntimeEvent(event: ProviderRuntimeEvent): TurnWorkItemRefs | undefined {
  const refs: Partial<Mutable<TurnWorkItemRefs>> = {};
  if (event.providerRefs?.providerTurnId) refs.providerTurnId = event.providerRefs.providerTurnId;
  if (event.providerRefs?.providerItemId) refs.providerItemId = event.providerRefs.providerItemId;
  if (event.providerRefs?.providerRequestId) {
    refs.providerRequestId = event.providerRefs.providerRequestId;
  }
  if (event.requestId) refs.requestId = event.requestId;

  const payload = asRecord(event.payload);
  const data = asRecord(payload?.data);
  const rawPayload = asRecord(event.raw?.payload);
  const toolCallId =
    asString(data?.toolCallId) ??
    asString(rawPayload?.toolCallId) ??
    asString(rawPayload?.tool_call_id) ??
    asString(rawPayload?.tool_use_id);
  if (toolCallId) refs.toolCallId = toolCallId;

  const taskId = asString(payload?.taskId);
  if (taskId) refs.taskId = taskId as RuntimeTaskId;

  const childThreadIds =
    Array.isArray(data?.childThreadIds) &&
    data.childThreadIds.every((value) => typeof value === "string")
      ? (data.childThreadIds as ThreadId[])
      : undefined;
  if (childThreadIds && childThreadIds.length > 0) refs.childThreadIds = childThreadIds;

  return Object.keys(refs).length > 0 ? (refs as TurnWorkItemRefs) : undefined;
}

function parentItemIdFromRuntimeEvent(event: ProviderRuntimeEvent): string | undefined {
  const rawPayload = asRecord(event.raw?.payload);
  const direct =
    asString(rawPayload?.parentItemId) ??
    asString(rawPayload?.parent_item_id) ??
    asString(rawPayload?.parent_tool_call_id) ??
    asString(rawPayload?.parent_tool_use_id);
  if (direct) return direct;

  switch (event.type) {
    case "task.started":
    case "task.progress":
    case "task.completed":
      return asString(rawPayload?.tool_use_id) ?? undefined;
    default:
      return undefined;
  }
}

function workKindFromItemType(itemType: CanonicalItemType): TurnWorkItemKind {
  switch (itemType) {
    case "assistant_message":
      return "assistant";
    case "reasoning":
      return "reasoning";
    case "plan":
      return "plan";
    case "command_execution":
      return "command";
    case "file_change":
      return "file_change";
    case "mcp_tool_call":
      return "mcp_tool";
    case "collab_agent_tool_call":
      return "subagent";
    case "web_search":
      return "web_search";
    case "image_view":
      return "image";
    case "error":
      return "error";
    case "dynamic_tool_call":
      return "tool";
    default:
      return "status";
  }
}

function workKindFromStreamKind(streamKind: RuntimeContentStreamKind): TurnWorkItemKind {
  switch (streamKind) {
    case "assistant_text":
      return "assistant";
    case "reasoning_text":
    case "reasoning_summary_text":
      return "reasoning";
    case "plan_text":
      return "plan";
    case "command_output":
      return "command";
    case "file_change_output":
      return "file_change";
    default:
      return "status";
  }
}

function titleForWorkKind(kind: TurnWorkItemKind): string {
  switch (kind) {
    case "assistant":
      return "Assistant message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command":
      return "Run command";
    case "file_change":
      return "File change";
    case "mcp_tool":
      return "MCP tool call";
    case "subagent":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image":
      return "Image view";
    case "approval":
      return "Approval request";
    case "error":
      return "Error";
    case "tool":
      return "Tool call";
    case "status":
      return "Status update";
  }
}

function workStatusFromRuntimeStatus(
  status: RuntimeItemStatus | undefined,
  fallback: TurnWorkItemStatus,
): TurnWorkItemStatus {
  switch (status) {
    case "inProgress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "declined":
      return "declined";
    default:
      return fallback;
  }
}

function eventSource(event: ProviderRuntimeEvent): Record<string, unknown> {
  return {
    eventType: event.type,
    ...(event.raw?.source ? { rawSource: event.raw.source } : {}),
    ...(event.raw?.method ? { rawMethod: event.raw.method } : {}),
    ...(event.raw?.messageType ? { rawMessageType: event.raw.messageType } : {}),
  };
}

function toolDataFromPayload(payloadData: unknown): {
  readonly toolName?: string;
  readonly input?: unknown;
  readonly result?: unknown;
} {
  const structured = extractStructuredProviderToolData(payloadData);
  if (structured) {
    return {
      toolName: structured.toolName,
      ...(structured.input !== null ? { input: structured.input } : {}),
      ...(structured.result !== undefined ? { result: structured.result } : {}),
    };
  }

  const data = asRecord(payloadData);
  if (!data) return {};
  return {
    ...(asString(data.toolName) ? { toolName: asString(data.toolName)! } : {}),
    ...(data.input !== undefined ? { input: data.input } : {}),
    ...(data.result !== undefined ? { result: data.result } : {}),
  };
}

function itemIdFromRuntimeEvent(event: ProviderRuntimeEvent, fallback: string): string {
  return (
    asString(event.itemId) ??
    asString(event.providerRefs?.providerItemId) ??
    asString(event.requestId) ??
    fallback
  );
}

function upsertWorkItem(
  state: MutableProjectionState,
  event: ProviderRuntimeEvent,
  input: {
    readonly id: string;
    readonly kind: TurnWorkItemKind;
    readonly status: TurnWorkItemStatus;
    readonly title: string;
    readonly parentId?: string | undefined;
    readonly detail?: string | undefined;
    readonly refs?: TurnWorkItemRefs | undefined;
    readonly input?: unknown;
    readonly output?: unknown;
    readonly error?: string | undefined;
    readonly data?: unknown;
    readonly completedAt?: string | undefined;
  },
): TurnWorkItem {
  const previous = state.items.get(input.id);
  const createdAt = previous?.createdAt ?? event.createdAt;
  const order = previous?.order ?? state.nextOrder++;
  const next: TurnWorkItem = {
    id: input.id,
    provider: event.provider,
    threadId: event.threadId,
    turnId: event.turnId!,
    order,
    kind: input.kind,
    status: input.status,
    title: input.title,
    createdAt,
    updatedAt: event.createdAt,
    streams: previous?.streams ?? [],
    source: eventSource(event),
    ...((input.parentId ?? previous?.parentId)
      ? { parentId: input.parentId ?? previous?.parentId }
      : {}),
    ...((input.detail ?? previous?.detail) ? { detail: input.detail ?? previous?.detail } : {}),
    ...((input.completedAt ?? previous?.completedAt)
      ? { completedAt: input.completedAt ?? previous?.completedAt }
      : {}),
    ...(mergeRefs(previous?.refs, input.refs)
      ? { refs: mergeRefs(previous?.refs, input.refs) }
      : {}),
    ...(input.input !== undefined
      ? { input: input.input }
      : previous?.input !== undefined
        ? { input: previous.input }
        : {}),
    ...(input.output !== undefined
      ? { output: input.output }
      : previous?.output !== undefined
        ? { output: previous.output }
        : {}),
    ...((input.error ?? previous?.error) ? { error: input.error ?? previous?.error } : {}),
    ...(input.data !== undefined
      ? { data: input.data }
      : previous?.data !== undefined
        ? { data: previous.data }
        : {}),
  };
  state.items.set(input.id, next);
  state.updatedAt = event.createdAt;
  return next;
}

function appendContentDelta(
  state: MutableProjectionState,
  event: Extract<ProviderRuntimeEvent, { type: "content.delta" }>,
): void {
  const itemId = itemIdFromRuntimeEvent(
    event,
    `${event.payload.streamKind}:${String(event.turnId)}:${event.eventId}`,
  );
  const kind = workKindFromStreamKind(event.payload.streamKind);
  const item =
    state.items.get(itemId) ??
    upsertWorkItem(state, event, {
      id: itemId,
      kind,
      status: "running",
      title: titleForWorkKind(kind),
      refs: providerRefsFromRuntimeEvent(event),
    });
  const streamId = [
    itemId,
    event.payload.streamKind,
    event.payload.contentIndex ?? 0,
    event.payload.summaryIndex ?? 0,
  ].join(":");
  const existingStream = item.streams.find((stream) => stream.id === streamId);
  const streams: TurnWorkContentStream[] = existingStream
    ? item.streams.map((stream) =>
        stream.id === streamId ? { ...stream, text: stream.text + event.payload.delta } : stream,
      )
    : [
        ...item.streams,
        {
          id: streamId,
          itemId,
          kind: event.payload.streamKind,
          text: event.payload.delta,
          ...(typeof event.payload.contentIndex === "number"
            ? { contentIndex: event.payload.contentIndex }
            : {}),
          ...(typeof event.payload.summaryIndex === "number"
            ? { summaryIndex: event.payload.summaryIndex }
            : {}),
        },
      ];
  state.items.set(itemId, { ...item, streams, updatedAt: event.createdAt });
  state.updatedAt = event.createdAt;
}

function applyRuntimeEvent(state: MutableProjectionState, event: ProviderRuntimeEvent): void {
  if (event.type === "runtime.warning") {
    return;
  }

  state.sourceEventIds.push(event.eventId);

  switch (event.type) {
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const payloadData = event.payload.data;
      const toolData = toolDataFromPayload(payloadData);
      const itemType = event.payload.itemType;
      const kind = workKindFromItemType(itemType);
      const fallbackStatus =
        event.type === "item.started"
          ? "running"
          : event.type === "item.completed"
            ? "completed"
            : "running";
      const status = workStatusFromRuntimeStatus(event.payload.status, fallbackStatus);
      const detail =
        event.payload.detail ??
        (toolData.toolName && asRecord(toolData.input)
          ? summarizeProviderToolInvocation(
              toolData.toolName,
              toolData.input as Record<string, unknown>,
            )
          : undefined);
      const title =
        event.payload.title ??
        (toolData.toolName ? providerToolTitle(toolData.toolName) : titleForWorkKind(kind));
      upsertWorkItem(state, event, {
        id: itemIdFromRuntimeEvent(event, event.eventId),
        kind,
        status,
        title,
        ...(parentItemIdFromRuntimeEvent(event)
          ? { parentId: parentItemIdFromRuntimeEvent(event) }
          : {}),
        ...(detail ? { detail } : {}),
        refs: providerRefsFromRuntimeEvent(event),
        ...(toolData.input !== undefined ? { input: toolData.input } : {}),
        ...(event.type === "item.completed" && toolData.result !== undefined
          ? { output: toolData.result }
          : event.type === "item.completed" && payloadData !== undefined
            ? { output: payloadData }
            : {}),
        ...(status === "failed" && detail ? { error: detail } : {}),
        ...(payloadData !== undefined ? { data: payloadData } : {}),
        ...(event.type === "item.completed" ? { completedAt: event.createdAt } : {}),
      });
      return;
    }

    case "content.delta":
      appendContentDelta(state, event);
      return;

    case "request.opened":
    case "user-input.requested": {
      const detail =
        event.type === "request.opened"
          ? event.payload.detail
          : event.payload.questions[0]?.question;
      upsertWorkItem(state, event, {
        id: `request:${String(event.requestId ?? event.eventId)}`,
        kind: "approval",
        status: "waiting",
        title: event.type === "request.opened" ? "Approval request" : "User input requested",
        ...(detail ? { detail } : {}),
        refs: providerRefsFromRuntimeEvent(event),
        ...(event.type === "request.opened" && event.payload.args !== undefined
          ? { input: event.payload.args }
          : event.type === "user-input.requested"
            ? { input: event.payload.questions }
            : {}),
      });
      return;
    }

    case "request.resolved":
    case "user-input.resolved": {
      const declined = event.type === "request.resolved" && event.payload.decision === "decline";
      upsertWorkItem(state, event, {
        id: `request:${String(event.requestId ?? event.eventId)}`,
        kind: "approval",
        status: declined ? "declined" : "completed",
        title: event.type === "request.resolved" ? "Approval resolved" : "User input submitted",
        refs: providerRefsFromRuntimeEvent(event),
        output:
          event.type === "request.resolved" ? event.payload.resolution : event.payload.answers,
        completedAt: event.createdAt,
      });
      return;
    }

    case "task.started":
    case "task.progress":
    case "task.completed": {
      const status =
        event.type === "task.started"
          ? "running"
          : event.type === "task.progress"
            ? "running"
            : event.payload.status === "failed"
              ? "failed"
              : event.payload.status === "stopped"
                ? "cancelled"
                : "completed";
      const detail =
        event.type === "task.started"
          ? event.payload.description
          : event.type === "task.progress"
            ? (event.payload.summary ?? event.payload.description)
            : event.payload.summary;
      upsertWorkItem(state, event, {
        id: `task:${String(event.payload.taskId)}`,
        kind: "subagent",
        status,
        title: event.type === "task.completed" ? "Subagent completed" : "Subagent task",
        ...(parentItemIdFromRuntimeEvent(event)
          ? { parentId: parentItemIdFromRuntimeEvent(event) }
          : {}),
        ...(detail ? { detail } : {}),
        refs: providerRefsFromRuntimeEvent(event),
        ...(event.type === "task.progress" && event.payload.usage !== undefined
          ? { data: { usage: event.payload.usage, lastToolName: event.payload.lastToolName } }
          : {}),
        ...(event.type === "task.completed" && event.payload.usage !== undefined
          ? { data: { usage: event.payload.usage, outputFile: event.payload.outputFile } }
          : {}),
        ...(status === "failed" && detail ? { error: detail } : {}),
        ...(event.type === "task.completed" ? { completedAt: event.createdAt } : {}),
      });
      return;
    }

    case "turn.plan.updated": {
      upsertWorkItem(state, event, {
        id: `plan:${String(event.turnId)}`,
        kind: "plan",
        status: "completed",
        title: "Plan",
        ...(event.payload.explanation ? { detail: event.payload.explanation } : {}),
        data: event.payload.plan,
        completedAt: event.createdAt,
      });
      return;
    }

    case "runtime.error": {
      upsertWorkItem(state, event, {
        id: `error:${event.eventId}`,
        kind: "error",
        status: "failed",
        title: "Runtime error",
        detail: event.payload.message,
        error: event.payload.message,
        completedAt: event.createdAt,
      });
      return;
    }

    default:
      return;
  }
}

function resolveParentIds(items: ReadonlyArray<TurnWorkItem>): TurnWorkItem[] {
  const ids = new Set(items.map((item) => item.id));
  return items.map((item) => {
    if (!item.parentId || ids.has(item.parentId)) {
      return item;
    }
    const toolParentId = `tool:${item.parentId}`;
    return ids.has(toolParentId) ? { ...item, parentId: toolParentId } : item;
  });
}

export function projectProviderRuntimeEventsToTurnWorkSnapshot(
  events: ReadonlyArray<ProviderRuntimeEvent>,
  options: ProviderRuntimeWorkProjectionOptions = {},
): TurnWorkSnapshot | null {
  const turnId = options.turnId ?? events.find((event) => event.turnId !== undefined)?.turnId;
  if (!turnId) {
    return null;
  }

  const turnEvents = events.filter((event) => event.turnId === turnId);
  const first = turnEvents[0];
  if (!first) {
    return null;
  }

  const state: MutableProjectionState = {
    items: new Map(),
    sourceEventIds: [],
    nextOrder: 0,
    updatedAt: first.createdAt,
  };

  for (const event of turnEvents) {
    applyRuntimeEvent(state, event);
  }

  const items = resolveParentIds(
    Array.from(state.items.values()).toSorted((left, right) => left.order - right.order),
  );
  return {
    provider: first.provider,
    threadId: first.threadId,
    turnId,
    updatedAt: state.updatedAt,
    items,
    sourceEventIds: state.sourceEventIds,
  };
}

export function isTurnWorkToolKind(kind: TurnWorkItemKind): boolean {
  return (
    kind === "command" ||
    kind === "file_change" ||
    kind === "tool" ||
    kind === "mcp_tool" ||
    kind === "subagent" ||
    kind === "web_search" ||
    kind === "image"
  );
}

export function workKindFromToolLifecycleItemType(
  itemType: ToolLifecycleItemType,
): TurnWorkItemKind {
  return workKindFromItemType(itemType);
}
