import {
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  requireKanbanItem,
  requireKanbanItemAbsent,
  requireProject,
  requireProjectAbsent,
  requireProjectWorkspaceRootAvailable,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
} from "./commandInvariants.ts";

const nowIso = () => new Date().toISOString();
const maxIso = (...values: ReadonlyArray<string | null | undefined>): string =>
  values.reduce<string>(
    (latest, value) => (value !== null && value !== undefined && value > latest ? value : latest),
    "",
  );
const defaultMetadata: Omit<OrchestrationEvent, "sequence" | "type" | "payload"> = {
  eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
  aggregateKind: "thread",
  aggregateId: "" as OrchestrationEvent["aggregateId"],
  occurredAt: nowIso(),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
};

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Omit<OrchestrationEvent, "sequence" | "type" | "payload"> {
  return {
    ...defaultMetadata,
    eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    correlationId: input.commandId,
    metadata: input.metadata ?? {},
  };
}

function withKanbanItemEventBase(
  command: Extract<OrchestrationCommand, { itemId: OrchestrationEvent["aggregateId"] }>,
  occurredAt: string,
): Omit<OrchestrationEvent, "sequence" | "type" | "payload"> {
  return withEventBase({
    aggregateKind: "kanbanItem",
    aggregateId: command.itemId,
    occurredAt,
    commandId: command.commandId,
  });
}

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  OrchestrationCommandInvariantError
> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireProjectWorkspaceRootAvailable({
        readModel,
        command,
        workspaceRoot: command.workspaceRoot,
      });

      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (command.workspaceRoot !== undefined) {
        yield* requireProjectWorkspaceRootAvailable({
          readModel,
          command,
          workspaceRoot: command.workspaceRoot,
          excludeProjectId: command.projectId,
        });
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.deleted",
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "kanbanItem.create": {
      yield* requireProject({ readModel, command, projectId: command.projectId });
      yield* requireKanbanItemAbsent({ readModel, command, itemId: command.itemId });
      return {
        ...withKanbanItemEventBase(command, command.createdAt),
        type: "kanbanItem.created",
        payload: {
          item: {
            id: command.itemId,
            projectId: command.projectId,
            pullRequest: command.pullRequest ?? null,
            title: command.title,
            description: command.description ?? "",
            prompt: command.prompt ?? "",
            generatedPrompt: command.generatedPrompt ?? null,
            promptStatus: command.promptStatus ?? "idle",
            promptError: command.promptError ?? null,
            status: command.status,
            sortKey: command.sortKey,
            blockedReason: null,
            assignees: command.assignees ?? [],
            notes: [],
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
            completedAt: command.status === "done" ? command.createdAt : null,
            deletedAt: null,
          },
        },
      };
    }

    case "kanbanItem.update": {
      yield* requireKanbanItem({ readModel, command, itemId: command.itemId });
      return {
        ...withKanbanItemEventBase(command, command.updatedAt),
        type: "kanbanItem.updated",
        payload: {
          itemId: command.itemId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.description !== undefined ? { description: command.description } : {}),
          ...(command.prompt !== undefined ? { prompt: command.prompt } : {}),
          ...(command.generatedPrompt !== undefined
            ? { generatedPrompt: command.generatedPrompt }
            : {}),
          ...(command.promptStatus !== undefined ? { promptStatus: command.promptStatus } : {}),
          ...(command.promptError !== undefined ? { promptError: command.promptError } : {}),
          ...(command.pullRequest !== undefined ? { pullRequest: command.pullRequest } : {}),
          updatedAt: command.updatedAt,
        },
      };
    }

    case "kanbanItem.move": {
      yield* requireKanbanItem({ readModel, command, itemId: command.itemId });
      return {
        ...withKanbanItemEventBase(command, command.movedAt),
        type: "kanbanItem.moved",
        payload: {
          itemId: command.itemId,
          status: command.status,
          sortKey: command.sortKey,
          movedAt: command.movedAt,
        },
      };
    }

    case "kanbanItem.assign": {
      yield* requireKanbanItem({ readModel, command, itemId: command.itemId });
      return {
        ...withKanbanItemEventBase(command, command.createdAt),
        type: "kanbanItem.assigned",
        payload: {
          itemId: command.itemId,
          assignee: command.assignee,
          updatedAt: command.createdAt,
        },
      };
    }

    case "kanbanItem.unassign": {
      yield* requireKanbanItem({ readModel, command, itemId: command.itemId });
      return {
        ...withKanbanItemEventBase(command, command.createdAt),
        type: "kanbanItem.unassigned",
        payload: {
          itemId: command.itemId,
          assigneeId: command.assigneeId,
          updatedAt: command.createdAt,
        },
      };
    }

    case "kanbanItem.block": {
      yield* requireKanbanItem({ readModel, command, itemId: command.itemId });
      return {
        ...withKanbanItemEventBase(command, command.blockedAt),
        type: "kanbanItem.blocked",
        payload: {
          itemId: command.itemId,
          reason: command.reason,
          blockedAt: command.blockedAt,
        },
      };
    }

    case "kanbanItem.unblock": {
      yield* requireKanbanItem({ readModel, command, itemId: command.itemId });
      return {
        ...withKanbanItemEventBase(command, command.unblockedAt),
        type: "kanbanItem.unblocked",
        payload: {
          itemId: command.itemId,
          unblockedAt: command.unblockedAt,
        },
      };
    }

    case "kanbanItem.complete": {
      yield* requireKanbanItem({ readModel, command, itemId: command.itemId });
      return {
        ...withKanbanItemEventBase(command, command.completedAt),
        type: "kanbanItem.completed",
        payload: {
          itemId: command.itemId,
          ...(command.sortKey !== undefined ? { sortKey: command.sortKey } : {}),
          completedAt: command.completedAt,
        },
      };
    }

    case "kanbanItem.note.add": {
      yield* requireKanbanItem({ readModel, command, itemId: command.itemId });
      return {
        ...withKanbanItemEventBase(command, command.createdAt),
        type: "kanbanItem.note-added",
        payload: {
          itemId: command.itemId,
          note: command.note,
          updatedAt: command.createdAt,
        },
      };
    }

    case "kanbanItem.delete": {
      yield* requireKanbanItem({ readModel, command, itemId: command.itemId });
      return {
        ...withKanbanItemEventBase(command, command.deletedAt),
        type: "kanbanItem.deleted",
        payload: {
          itemId: command.itemId,
          deletedAt: command.deletedAt,
        },
      };
    }

    case "thread.create": {
      if (command.projectId !== null) {
        yield* requireProject({
          readModel,
          command,
          projectId: command.projectId,
        });
      }
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      const parentThreadId = command.parentThreadId ?? null;
      const branchSourceTurnId = command.branchSourceTurnId ?? null;
      const parentThread =
        parentThreadId !== null
          ? yield* requireThread({
              readModel,
              command,
              threadId: parentThreadId,
            })
          : null;
      if (parentThread && parentThread.projectId !== command.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Parent thread '${parentThread.id}' belongs to a different project.`,
        });
      }
      if (parentThread && parentThread.archivedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Parent thread '${parentThread.id}' is archived.`,
        });
      }
      if (parentThreadId === null && branchSourceTurnId !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "branchSourceTurnId requires a parentThreadId.",
        });
      }
      if (
        parentThread &&
        branchSourceTurnId !== null &&
        parentThread.latestTurn?.turnId !== branchSourceTurnId
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `branchSourceTurnId '${branchSourceTurnId}' does not match the parent thread head.`,
        });
      }
      const threadCreatedEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created" as const,
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          projectlessCwd: command.projectlessCwd ?? null,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          parentThreadId,
          branchSourceTurnId,
          branch: command.branch,
          worktreePath: command.worktreePath,
          tag: command.tag ?? null,
          pinnedAt: null,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const seedMessageEvents = (command.seedMessages ?? []).map((message) => {
        const base = withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        });
        return {
          eventId: base.eventId,
          aggregateKind: base.aggregateKind,
          aggregateId: base.aggregateId,
          occurredAt: base.occurredAt,
          commandId: base.commandId,
          causationEventId: base.causationEventId,
          correlationId: base.correlationId,
          metadata: base.metadata,
          type: "thread.message-sent" as const,
          payload: {
            threadId: command.threadId,
            messageId: message.messageId,
            role: message.role,
            text: message.text,
            ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
            turnId: null,
            streaming: false,
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
          },
        };
      });
      return [threadCreatedEvent, ...seedMessageEvents];
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.archive": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      const archivedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
      if (thread.goal?.status !== "active") {
        return archivedEvent;
      }
      const goalUpdatedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
          metadata: { threadGoalMutation: "user" },
        }),
        type: "thread.goal-updated",
        payload: {
          threadId: command.threadId,
          goal: {
            ...thread.goal,
            status: "paused",
            updatedAt: maxIso(occurredAt, thread.goal.updatedAt, thread.latestTurn?.startedAt),
          },
          ...(thread.session?.activeTurnId !== null && thread.session?.activeTurnId !== undefined
            ? { turnId: thread.session.activeTurnId }
            : {}),
        },
      };
      return [goalUpdatedEvent, { ...archivedEvent, causationEventId: goalUpdatedEvent.eventId }];
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.meta.update": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          ...(command.tag !== undefined ? { tag: command.tag } : {}),
          ...(command.pinnedAt !== undefined ? { pinnedAt: command.pinnedAt } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.goal.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.deletedAt !== null || thread.archivedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' cannot mutate a goal after deletion or archival.`,
        });
      }
      if (command.objective === undefined && thread.goal === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Creating a thread goal requires an objective.",
        });
      }
      const previous = thread.goal ?? null;
      const previousLifecycleKey = previous?.lifecycleId ?? previous?.createdAt ?? null;
      if (
        (command.expectedGoalLifecycleKey === undefined && previousLifecycleKey !== null) ||
        (command.expectedGoalLifecycleKey !== undefined &&
          command.expectedGoalLifecycleKey !== previousLifecycleKey)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Goal update for thread '${command.threadId}' targets a stale lifecycle.`,
        });
      }
      if (previous !== null && command.status === "paused" && previous.status !== "active") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Goal for thread '${command.threadId}' cannot be paused from status '${previous.status}'.`,
        });
      }
      const tokenBudget =
        command.tokenBudget !== undefined ? command.tokenBudget : (previous?.tokenBudget ?? null);
      const tokensUsed = previous?.tokensUsed ?? 0;
      const requestedStatus = command.status ?? previous?.status ?? ("active" as const);
      const status =
        requestedStatus === "active" && tokenBudget !== null && tokensUsed >= tokenBudget
          ? ("budgetLimited" as const)
          : requestedStatus;
      const objective = command.objective ?? previous!.objective;
      const shouldRotateLifecycle =
        previous !== null &&
        ((command.objective !== undefined && objective !== previous.objective) ||
          (status === "active" && previous.status !== "active"));
      const goal = {
        threadId: command.threadId,
        ...(shouldRotateLifecycle
          ? { lifecycleId: `goal:${command.commandId}` }
          : previous?.lifecycleId !== undefined
            ? { lifecycleId: previous.lifecycleId }
            : previous === null
              ? { lifecycleId: `goal:${command.commandId}` }
              : {}),
        objective,
        status,
        tokenBudget,
        tokensUsed,
        timeUsedSeconds: previous?.timeUsedSeconds ?? 0,
        createdAt: previous?.createdAt ?? command.createdAt,
        updatedAt: maxIso(
          command.createdAt,
          previous?.updatedAt,
          (thread.session?.activeTurnId ?? null) !== null ? thread.latestTurn?.startedAt : null,
        ),
      };
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: { threadGoalMutation: "user" },
        }),
        type: "thread.goal-updated",
        payload: {
          threadId: command.threadId,
          goal,
        },
      };
    }

    case "thread.goal.clear": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.deletedAt !== null || thread.archivedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' cannot clear a goal after deletion or archival.`,
        });
      }
      const currentLifecycleKey = thread.goal?.lifecycleId ?? thread.goal?.createdAt ?? null;
      if (
        (command.expectedGoalLifecycleKey === undefined && currentLifecycleKey !== null) ||
        (command.expectedGoalLifecycleKey !== undefined &&
          command.expectedGoalLifecycleKey !== currentLifecycleKey)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Goal clear for thread '${command.threadId}' targets a stale lifecycle.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: { threadGoalMutation: "user" },
        }),
        type: "thread.goal-cleared",
        payload: {
          threadId: command.threadId,
          ...(currentLifecycleKey !== null ? { goalLifecycleKey: currentLifecycleKey } : {}),
          clearedAt: command.createdAt,
        },
      };
    }

    case "thread.goal.snapshot.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.goal.threadId !== command.threadId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Goal snapshot thread '${command.goal.threadId}' does not match command thread '${command.threadId}'.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.goal-updated",
        payload: {
          threadId: command.threadId,
          goal: command.goal,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
        },
      };
    }

    case "thread.goal.usage.record": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const current = thread.goal;
      const currentLifecycleKey = current?.lifecycleId ?? current?.createdAt;
      if (!current || currentLifecycleKey !== command.expectedGoalLifecycleKey) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Goal usage for thread '${command.threadId}' targets a stale lifecycle.`,
        });
      }
      if (command.tokensDelta === 0 && command.timeDeltaSeconds === 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Goal usage must record a positive token or time delta.",
        });
      }

      const tokensUsed = Math.min(
        Number.MAX_SAFE_INTEGER,
        current.tokensUsed + command.tokensDelta,
      );
      const timeUsedSeconds = Math.min(
        Number.MAX_SAFE_INTEGER,
        current.timeUsedSeconds + command.timeDeltaSeconds,
      );
      const status =
        current.status === "active" &&
        current.tokenBudget !== null &&
        tokensUsed >= current.tokenBudget
          ? ("budgetLimited" as const)
          : current.status;
      const goal = {
        ...current,
        status,
        tokensUsed,
        timeUsedSeconds,
        updatedAt: command.createdAt > current.updatedAt ? command.createdAt : current.updatedAt,
      };
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.goal-updated",
        payload: {
          threadId: command.threadId,
          goal,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
        },
      };
    }

    case "thread.goal.status.report": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const current = thread.goal;
      const currentLifecycleKey = current?.lifecycleId ?? current?.createdAt;
      if (!current || currentLifecycleKey !== command.expectedGoalLifecycleKey) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Goal status for thread '${command.threadId}' targets a stale lifecycle.`,
        });
      }
      if (current.status === "budgetLimited" && command.status !== "complete") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A provider report cannot overwrite a harness-enforced goal budget limit.",
        });
      }
      if (
        current.status !== "active" &&
        current.status !== "budgetLimited" &&
        current.status !== command.status
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Goal status '${current.status}' cannot be changed by a provider report.`,
        });
      }

      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.goal-updated",
        payload: {
          threadId: command.threadId,
          goal: {
            ...current,
            status: command.status,
            updatedAt: maxIso(
              command.createdAt,
              current.updatedAt,
              command.turnId !== undefined && thread.latestTurn?.turnId === command.turnId
                ? thread.latestTurn.startedAt
                : null,
            ),
          },
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
        },
      };
    }

    case "thread.goal.continue": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const current = thread.goal;
      if (thread.deletedAt !== null || thread.archivedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' cannot continue a goal after deletion or archival.`,
        });
      }
      const currentLifecycleKey = current?.lifecycleId ?? current?.createdAt;
      if (!current || currentLifecycleKey !== command.expectedGoalLifecycleKey) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Goal continuation for thread '${command.threadId}' targets a stale lifecycle.`,
        });
      }
      if (current.status !== "active") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Goal continuation requires an active goal, not '${current.status}'.`,
        });
      }
      if (thread.interactionMode === "plan") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Plan-mode threads cannot automatically continue a goal.",
        });
      }
      if (thread.session?.status === "running" || (thread.session?.activeTurnId ?? null) !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Goal continuation requires thread '${command.threadId}' to be idle.`,
        });
      }

      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.goal-continuation-requested",
        payload: {
          threadId: command.threadId,
          expectedGoalLifecycleKey: command.expectedGoalLifecycleKey,
          messageId: MessageId.makeUnsafe(`goal-continuation:${command.commandId}`),
          ...(command.sourceTurnId !== undefined ? { sourceTurnId: command.sourceTurnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.goal.snapshot.clear": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.goal-cleared",
        payload: {
          threadId: command.threadId,
          clearedAt: command.clearedAt,
        },
      };
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const currentGoalLifecycleKey =
        targetThread.goal?.lifecycleId ?? targetThread.goal?.createdAt ?? null;
      if (
        command.goalIntent !== undefined &&
        ((command.goalIntent.expectedGoalLifecycleKey === undefined &&
          currentGoalLifecycleKey !== null) ||
          (command.goalIntent.expectedGoalLifecycleKey !== undefined &&
            command.goalIntent.expectedGoalLifecycleKey !== currentGoalLifecycleKey))
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Goal replacement for thread '${command.threadId}' targets a stale lifecycle.`,
        });
      }
      if (
        command.goalIntent !== undefined &&
        (command.interactionMode === "plan" || targetThread.interactionMode === "plan")
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Plan-mode turns cannot start or account for a thread goal.",
        });
      }
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const goalUpdatedEvent: Omit<OrchestrationEvent, "sequence"> | null = command.goalIntent
        ? {
            ...withEventBase({
              aggregateKind: "thread",
              aggregateId: command.threadId,
              occurredAt: command.createdAt,
              commandId: command.commandId,
            }),
            causationEventId: userMessageEvent.eventId,
            type: "thread.goal-updated",
            payload: {
              threadId: command.threadId,
              goal: {
                threadId: command.threadId,
                lifecycleId: `goal:${command.commandId}`,
                objective: command.goalIntent.objective,
                status: "active",
                tokenBudget: command.goalIntent.tokenBudget,
                tokensUsed: 0,
                timeUsedSeconds: 0,
                createdAt: command.createdAt,
                updatedAt: command.createdAt,
              },
            },
          }
        : null;
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: goalUpdatedEvent?.eventId ?? userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          goalLifecycleKey:
            targetThread.interactionMode === "plan"
              ? null
              : command.goalIntent !== undefined
                ? `goal:${command.commandId}`
                : targetThread.goal?.status === "active"
                  ? (targetThread.goal.lifecycleId ?? targetThread.goal.createdAt)
                  : null,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          createdAt: command.createdAt,
        },
      };
      return goalUpdatedEvent
        ? [userMessageEvent, goalUpdatedEvent, turnStartRequestedEvent]
        : [userMessageEvent, turnStartRequestedEvent];
    }

    case "thread.turn.steer": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const currentGoalLifecycleKey =
        targetThread.goal?.lifecycleId ?? targetThread.goal?.createdAt ?? null;
      if (
        command.goalIntent !== undefined &&
        ((command.goalIntent.expectedGoalLifecycleKey === undefined &&
          currentGoalLifecycleKey !== null) ||
          (command.goalIntent.expectedGoalLifecycleKey !== undefined &&
            command.goalIntent.expectedGoalLifecycleKey !== currentGoalLifecycleKey))
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Goal replacement for thread '${command.threadId}' targets a stale lifecycle.`,
        });
      }
      if (command.goalIntent !== undefined && targetThread.interactionMode === "plan") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Plan-mode turns cannot start or account for a thread goal.",
        });
      }
      const activeTurnId =
        command.turnId ??
        targetThread.session?.activeTurnId ??
        (targetThread.latestTurn?.state === "running" ? targetThread.latestTurn.turnId : null);
      if (!activeTurnId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Cannot steer thread '${command.threadId}' because it has no running turn.`,
        });
      }
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          turnId: activeTurnId,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const goalUpdatedEvent: Omit<OrchestrationEvent, "sequence"> | null = command.goalIntent
        ? {
            ...withEventBase({
              aggregateKind: "thread",
              aggregateId: command.threadId,
              occurredAt: command.createdAt,
              commandId: command.commandId,
            }),
            causationEventId: userMessageEvent.eventId,
            type: "thread.goal-updated",
            payload: {
              threadId: command.threadId,
              goal: {
                threadId: command.threadId,
                lifecycleId: `goal:${command.commandId}`,
                objective: command.goalIntent.objective,
                status: "active",
                tokenBudget: command.goalIntent.tokenBudget,
                tokensUsed: 0,
                timeUsedSeconds: 0,
                createdAt: command.createdAt,
                updatedAt: command.createdAt,
              },
            },
          }
        : null;
      const turnSteerRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: goalUpdatedEvent?.eventId ?? userMessageEvent.eventId,
        type: "thread.turn-steer-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          turnId: activeTurnId,
          goalLifecycleKey:
            targetThread.interactionMode === "plan"
              ? null
              : command.goalIntent !== undefined
                ? `goal:${command.commandId}`
                : targetThread.goal?.status === "active"
                  ? (targetThread.goal.lifecycleId ?? targetThread.goal.createdAt)
                  : null,
          createdAt: command.createdAt,
        },
      };
      return goalUpdatedEvent
        ? [userMessageEvent, goalUpdatedEvent, turnSteerRequestedEvent]
        : [userMessageEvent, turnSteerRequestedEvent];
    }

    case "thread.turn.interrupt": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const goalUpdatedEvent: Omit<OrchestrationEvent, "sequence"> | null =
        thread.goal?.status === "active"
          ? {
              ...withEventBase({
                aggregateKind: "thread",
                aggregateId: command.threadId,
                occurredAt: command.createdAt,
                commandId: command.commandId,
                metadata: { threadGoalMutation: "interrupt" },
              }),
              type: "thread.goal-updated",
              payload: {
                threadId: command.threadId,
                goal: {
                  ...thread.goal,
                  status: "paused",
                  updatedAt: maxIso(
                    command.createdAt,
                    thread.goal.updatedAt,
                    thread.latestTurn?.startedAt,
                  ),
                },
                ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
              },
            }
          : null;
      const interruptRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: goalUpdatedEvent?.eventId ?? null,
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
      if (goalUpdatedEvent) {
        return [goalUpdatedEvent, interruptRequestedEvent];
      }
      return interruptRequestedEvent;
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.turn.retry": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-retry-requested",
        payload: {
          threadId: command.threadId,
          assistantMessageId: command.assistantMessageId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.message.edit": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-edit-requested",
        payload: {
          threadId: command.threadId,
          userMessageId: command.userMessageId,
          text: command.text,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const goalUpdatedEvent: Omit<OrchestrationEvent, "sequence"> | null =
        thread.goal?.status === "active"
          ? {
              ...withEventBase({
                aggregateKind: "thread",
                aggregateId: command.threadId,
                occurredAt: command.createdAt,
                commandId: command.commandId,
                metadata: { threadGoalMutation: "interrupt" },
              }),
              type: "thread.goal-updated",
              payload: {
                threadId: command.threadId,
                goal: {
                  ...thread.goal,
                  status: "paused",
                  updatedAt: maxIso(
                    command.createdAt,
                    thread.goal.updatedAt,
                    thread.latestTurn?.startedAt,
                  ),
                },
                ...(thread.session?.activeTurnId ? { turnId: thread.session.activeTurnId } : {}),
              },
            }
          : null;
      const sessionStopRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
      if (goalUpdatedEvent) {
        return [
          goalUpdatedEvent,
          { ...sessionStopRequestedEvent, causationEventId: goalUpdatedEvent.eventId },
        ];
      }
      return sessionStopRequestedEvent;
    }

    case "thread.session.ensure": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.session-ensure-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        }),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
    }

    case "thread.resume-state.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        }),
        type: "thread.resume-state-set",
        payload: {
          threadId: command.threadId,
          resumeState: command.resumeState,
        },
      };
    }

    case "thread.message.assistant.delta": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        }),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
