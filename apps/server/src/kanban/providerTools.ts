import type {
  CommandId,
  KanbanItem,
  KanbanItemAssigneeId,
  KanbanItemAssigneeRole,
  KanbanItemId,
  KanbanItemNoteId,
  KanbanItemStatus,
  OrchestrationCommand,
  ProviderKind,
  ThreadId,
} from "contracts";
import { Effect } from "effect";

import type { ProviderMcpToolRuntime } from "../provider/mcpServers.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";

function newCommandId(): CommandId {
  return `provider:kanban:${crypto.randomUUID()}` as CommandId;
}

function newAssigneeId(): KanbanItemAssigneeId {
  return `kanban_assignee_${crypto.randomUUID()}` as KanbanItemAssigneeId;
}

function newNoteId(): KanbanItemNoteId {
  return `kanban_note_${crypto.randomUUID()}` as KanbanItemNoteId;
}

function newSortKey(): string {
  return `${Date.now().toString().padStart(13, "0")}_${crypto.randomUUID()}`;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStatus(value: unknown): KanbanItemStatus | null {
  return value === "backlog" || value === "todo" || value === "in_progress" || value === "done"
    ? value
    : null;
}

function asRole(value: unknown): KanbanItemAssigneeRole {
  return value === "reviewer" || value === "researcher" || value === "tester" ? value : "owner";
}

function itemSummary(item: KanbanItem) {
  return {
    id: item.id,
    projectId: item.projectId,
    pullRequest: item.pullRequest,
    title: item.title,
    description: item.description,
    prompt: item.prompt,
    generatedPrompt: item.generatedPrompt,
    promptStatus: item.promptStatus,
    promptError: item.promptError,
    status: item.status,
    blockedReason: item.blockedReason,
    assignees: item.assignees,
    notes: item.notes,
    updatedAt: item.updatedAt,
  };
}

async function dispatch(engine: OrchestrationEngineShape, command: OrchestrationCommand) {
  await Effect.runPromise(engine.dispatch(command));
}

export function makeKanbanProviderToolRuntime(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly provider: ProviderKind;
  readonly threadId?: ThreadId | undefined;
}): ProviderMcpToolRuntime {
  const descriptors: ProviderMcpToolRuntime["descriptors"] = [
    {
      name: "kanban_list",
      title: "Kanban · List tasks",
      description: "List ShioriCode Kanban tasks, optionally filtered by project or pull request.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          pullRequestNumber: { type: "number" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "kanban_get",
      title: "Kanban · Get task",
      description: "Get one ShioriCode Kanban task by id.",
      inputSchema: {
        type: "object",
        properties: { itemId: { type: "string" } },
        required: ["itemId"],
        additionalProperties: false,
      },
    },
    {
      name: "kanban_claim",
      title: "Kanban · Claim task",
      description: "Assign the current provider thread to a ShioriCode Kanban task.",
      inputSchema: {
        type: "object",
        properties: {
          itemId: { type: "string" },
          role: { type: "string", enum: ["owner", "reviewer", "researcher", "tester"] },
        },
        required: ["itemId"],
        additionalProperties: false,
      },
    },
    {
      name: "kanban_update_status",
      title: "Kanban · Update status",
      description: "Move a ShioriCode Kanban task to another board status.",
      inputSchema: {
        type: "object",
        properties: {
          itemId: { type: "string" },
          status: { type: "string", enum: ["backlog", "todo", "in_progress", "done"] },
        },
        required: ["itemId", "status"],
        additionalProperties: false,
      },
    },
    {
      name: "kanban_add_note",
      title: "Kanban · Add note",
      description: "Add an activity note to a ShioriCode Kanban task.",
      inputSchema: {
        type: "object",
        properties: { itemId: { type: "string" }, body: { type: "string" } },
        required: ["itemId", "body"],
        additionalProperties: false,
      },
    },
    {
      name: "kanban_block",
      title: "Kanban · Block task",
      description: "Mark a ShioriCode Kanban task as blocked with a reason.",
      inputSchema: {
        type: "object",
        properties: { itemId: { type: "string" }, reason: { type: "string" } },
        required: ["itemId", "reason"],
        additionalProperties: false,
      },
    },
    {
      name: "kanban_unblock",
      title: "Kanban · Unblock task",
      description: "Clear the blocked state from a ShioriCode Kanban task.",
      inputSchema: {
        type: "object",
        properties: { itemId: { type: "string" } },
        required: ["itemId"],
        additionalProperties: false,
      },
    },
    {
      name: "kanban_complete",
      title: "Kanban · Complete task",
      description: "Move a ShioriCode Kanban task to Done.",
      inputSchema: {
        type: "object",
        properties: { itemId: { type: "string" } },
        required: ["itemId"],
        additionalProperties: false,
      },
    },
  ];

  const executors: ProviderMcpToolRuntime["executors"] = new Map(
    descriptors.map((descriptor) => [
      descriptor.name,
      {
        title: descriptor.title ?? descriptor.name,
        execute: async (toolInput: Record<string, unknown>) => {
          const readModel = await Effect.runPromise(input.orchestrationEngine.getReadModel());
          const activeItems = (readModel.kanbanItems ?? []).filter(
            (item) => item.deletedAt === null,
          );

          if (descriptor.name === "kanban_list") {
            const projectId = asString(toolInput.projectId);
            const pullRequestNumber = asNumber(toolInput.pullRequestNumber);
            return activeItems
              .filter((item) => (projectId ? item.projectId === projectId : true))
              .filter((item) =>
                pullRequestNumber !== null ? item.pullRequest?.number === pullRequestNumber : true,
              )
              .map(itemSummary);
          }

          const itemId = asString(toolInput.itemId) as KanbanItemId | null;
          const item = itemId ? activeItems.find((entry) => entry.id === itemId) : undefined;
          if (!itemId || !item) {
            return { error: "Kanban task not found." };
          }

          const now = new Date().toISOString();
          switch (descriptor.name) {
            case "kanban_get":
              return itemSummary(item);
            case "kanban_claim":
              await dispatch(input.orchestrationEngine, {
                type: "kanbanItem.assign",
                commandId: newCommandId(),
                itemId,
                assignee: {
                  id: newAssigneeId(),
                  provider: input.provider,
                  role: asRole(toolInput.role),
                  status: "claimed",
                  threadId: input.threadId ?? null,
                  assignedAt: now,
                  updatedAt: now,
                },
                createdAt: now,
              });
              return { ok: true };
            case "kanban_update_status": {
              const status = asStatus(toolInput.status);
              if (!status) return { error: "Invalid Kanban status." };
              await dispatch(input.orchestrationEngine, {
                type: "kanbanItem.move",
                commandId: newCommandId(),
                itemId,
                status,
                sortKey: newSortKey(),
                movedAt: now,
              });
              return { ok: true };
            }
            case "kanban_add_note": {
              const body = asString(toolInput.body);
              if (!body) return { error: "Note body is required." };
              await dispatch(input.orchestrationEngine, {
                type: "kanbanItem.note.add",
                commandId: newCommandId(),
                itemId,
                note: {
                  id: newNoteId(),
                  body,
                  authorKind: "provider",
                  authorName: input.provider,
                  createdAt: now,
                },
                createdAt: now,
              });
              return { ok: true };
            }
            case "kanban_block": {
              const reason = asString(toolInput.reason);
              if (!reason) return { error: "Blocked reason is required." };
              await dispatch(input.orchestrationEngine, {
                type: "kanbanItem.block",
                commandId: newCommandId(),
                itemId,
                reason,
                blockedAt: now,
              });
              return { ok: true };
            }
            case "kanban_unblock":
              await dispatch(input.orchestrationEngine, {
                type: "kanbanItem.unblock",
                commandId: newCommandId(),
                itemId,
                unblockedAt: now,
              });
              return { ok: true };
            case "kanban_complete":
              await dispatch(input.orchestrationEngine, {
                type: "kanbanItem.complete",
                commandId: newCommandId(),
                itemId,
                sortKey: newSortKey(),
                completedAt: now,
              });
              return { ok: true };
            default:
              return { error: "Unknown Kanban tool." };
          }
        },
      },
    ]),
  );

  return {
    descriptors,
    executors,
    warnings: [],
    close: async () => {},
  };
}
