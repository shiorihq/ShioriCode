import { GOAL_ITEMS_READ_MODEL_KEY, GoalItemCommandType } from "contracts";
import type {
  CommandId,
  GoalItem,
  GoalItemAssigneeId,
  GoalItemAssigneeRole,
  GoalItemId,
  GoalItemNoteId,
  GoalItemStatus,
  OrchestrationCommand,
  ProviderKind,
  ThreadId,
} from "contracts";
import { Effect } from "effect";

import type { ProviderMcpToolRuntime } from "../provider/mcpServers.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";

function newCommandId(): CommandId {
  return `provider:goal:${crypto.randomUUID()}` as CommandId;
}

function newAssigneeId(): GoalItemAssigneeId {
  return `goal_assignee_${crypto.randomUUID()}` as GoalItemAssigneeId;
}

function newNoteId(): GoalItemNoteId {
  return `goal_note_${crypto.randomUUID()}` as GoalItemNoteId;
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

function asStatus(value: unknown): GoalItemStatus | null {
  return value === "backlog" || value === "todo" || value === "in_progress" || value === "done"
    ? value
    : null;
}

function asRole(value: unknown): GoalItemAssigneeRole {
  return value === "reviewer" || value === "researcher" || value === "tester" ? value : "owner";
}

function itemSummary(item: GoalItem) {
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

export function makeGoalProviderToolRuntime(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly provider: ProviderKind;
  readonly threadId?: ThreadId | undefined;
}): ProviderMcpToolRuntime {
  const descriptors: ProviderMcpToolRuntime["descriptors"] = [
    {
      name: "goal_list",
      title: "Goals · List goals",
      description: "List ShioriCode goals, optionally filtered by project or pull request.",
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
      name: "goal_get",
      title: "Goals · Get goal",
      description: "Get one ShioriCode goal by id.",
      inputSchema: {
        type: "object",
        properties: { itemId: { type: "string" } },
        required: ["itemId"],
        additionalProperties: false,
      },
    },
    {
      name: "goal_claim",
      title: "Goals · Claim goal",
      description: "Assign the current provider thread to a ShioriCode goal.",
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
      name: "goal_update_status",
      title: "Goals · Update status",
      description: "Move a ShioriCode goal to another status.",
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
      name: "goal_add_note",
      title: "Goals · Add note",
      description: "Add an activity note to a ShioriCode goal.",
      inputSchema: {
        type: "object",
        properties: { itemId: { type: "string" }, body: { type: "string" } },
        required: ["itemId", "body"],
        additionalProperties: false,
      },
    },
    {
      name: "goal_block",
      title: "Goals · Block goal",
      description: "Mark a ShioriCode goal as blocked with a reason.",
      inputSchema: {
        type: "object",
        properties: { itemId: { type: "string" }, reason: { type: "string" } },
        required: ["itemId", "reason"],
        additionalProperties: false,
      },
    },
    {
      name: "goal_unblock",
      title: "Goals · Unblock goal",
      description: "Clear the blocked state from a ShioriCode goal.",
      inputSchema: {
        type: "object",
        properties: { itemId: { type: "string" } },
        required: ["itemId"],
        additionalProperties: false,
      },
    },
    {
      name: "goal_complete",
      title: "Goals · Complete goal",
      description: "Move a ShioriCode goal to Done.",
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
          const activeItems = (readModel[GOAL_ITEMS_READ_MODEL_KEY] ?? []).filter(
            (item) => item.deletedAt === null,
          );

          if (descriptor.name === "goal_list") {
            const projectId = asString(toolInput.projectId);
            const pullRequestNumber = asNumber(toolInput.pullRequestNumber);
            return activeItems
              .filter((item) => (projectId ? item.projectId === projectId : true))
              .filter((item) =>
                pullRequestNumber !== null ? item.pullRequest?.number === pullRequestNumber : true,
              )
              .map(itemSummary);
          }

          const itemId = asString(toolInput.itemId) as GoalItemId | null;
          const item = itemId ? activeItems.find((entry) => entry.id === itemId) : undefined;
          if (!itemId || !item) {
            return { error: "Goal not found." };
          }

          const now = new Date().toISOString();
          switch (descriptor.name) {
            case "goal_get":
              return itemSummary(item);
            case "goal_claim":
              await dispatch(input.orchestrationEngine, {
                type: GoalItemCommandType.assign,
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
            case "goal_update_status": {
              const status = asStatus(toolInput.status);
              if (!status) return { error: "Invalid goal status." };
              await dispatch(input.orchestrationEngine, {
                type: GoalItemCommandType.move,
                commandId: newCommandId(),
                itemId,
                status,
                sortKey: newSortKey(),
                movedAt: now,
              });
              return { ok: true };
            }
            case "goal_add_note": {
              const body = asString(toolInput.body);
              if (!body) return { error: "Note body is required." };
              await dispatch(input.orchestrationEngine, {
                type: GoalItemCommandType.addNote,
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
            case "goal_block": {
              const reason = asString(toolInput.reason);
              if (!reason) return { error: "Blocked reason is required." };
              await dispatch(input.orchestrationEngine, {
                type: GoalItemCommandType.block,
                commandId: newCommandId(),
                itemId,
                reason,
                blockedAt: now,
              });
              return { ok: true };
            }
            case "goal_unblock":
              await dispatch(input.orchestrationEngine, {
                type: GoalItemCommandType.unblock,
                commandId: newCommandId(),
                itemId,
                unblockedAt: now,
              });
              return { ok: true };
            case "goal_complete":
              await dispatch(input.orchestrationEngine, {
                type: GoalItemCommandType.complete,
                commandId: newCommandId(),
                itemId,
                sortKey: newSortKey(),
                completedAt: now,
              });
              return { ok: true };
            default:
              return { error: "Unknown goal tool." };
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
