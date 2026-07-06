import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  type ChatAttachment,
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
} from "contracts";
import { Cause, Effect, Layer, Option, Stream } from "effect";
import { makeDrainableWorker } from "shared/DrainableWorker";
import { extractChangedFilesFromProviderData } from "shared/providerFileChanges";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import {
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import { createAttachmentId, resolveAttachmentPath } from "../../attachmentStore.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { type ProviderServiceError } from "../../provider/Errors.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import { OrchestrationDispatchError } from "../Errors.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { ServerConfig } from "../../config.ts";
import { type OrchestrationEventStoreError } from "../../persistence/Errors.ts";
import { WorkspaceEntries } from "../../workspace/Services/WorkspaceEntries.ts";

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
    };

interface CheckpointFileSummary {
  readonly path: string;
  readonly kind: string;
  readonly additions: number;
  readonly deletions: number;
}

interface CheckpointActivity {
  readonly payload: unknown;
  readonly turnId: TurnId | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function normalizeChangedFilePath(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function collectFileChangeActivityPaths(
  activities: ReadonlyArray<CheckpointActivity>,
  turnId: TurnId,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const paths: string[] = [];

  for (const activity of activities) {
    if (activity.turnId !== turnId) {
      continue;
    }

    const payload = asRecord(activity.payload);
    if (payload?.itemType !== "file_change") {
      continue;
    }

    for (const rawPath of extractChangedFilesFromProviderData(payload.data, { maxFiles: 500 })) {
      const filePath = normalizeChangedFilePath(rawPath);
      if (!filePath || seen.has(filePath)) {
        continue;
      }
      seen.add(filePath);
      paths.push(filePath);
    }
  }

  return paths;
}

function indexCheckpointFilesByPath(
  files: ReadonlyArray<CheckpointFileSummary> | undefined,
): ReadonlyMap<string, CheckpointFileSummary> {
  const byPath = new Map<string, CheckpointFileSummary>();
  for (const file of files ?? []) {
    const filePath = normalizeChangedFilePath(file.path);
    if (!filePath || byPath.has(filePath)) {
      continue;
    }
    byPath.set(filePath, file);
  }
  return byPath;
}

function selectThreadScopedCheckpointFiles(input: {
  readonly activities: ReadonlyArray<CheckpointActivity>;
  readonly turnId: TurnId;
  readonly derivedFiles: ReadonlyArray<CheckpointFileSummary>;
  readonly preferredFiles?: ReadonlyArray<CheckpointFileSummary>;
}): ReadonlyArray<CheckpointFileSummary> {
  const activityPaths = collectFileChangeActivityPaths(input.activities, input.turnId);
  if (activityPaths.length === 0) {
    return input.preferredFiles && input.preferredFiles.length > 0
      ? input.preferredFiles
      : input.derivedFiles;
  }

  const derivedByPath = indexCheckpointFilesByPath(input.derivedFiles);
  const preferredByPath = indexCheckpointFilesByPath(input.preferredFiles);
  return activityPaths
    .map((path) => {
      const source = derivedByPath.get(path) ?? preferredByPath.get(path);
      return {
        path,
        kind: source?.kind ?? "modified",
        additions: source?.additions ?? 0,
        deletions: source?.deletions ?? 0,
      };
    })
    .toSorted((left, right) => left.path.localeCompare(right.path));
}

class TurnRestartAttachmentCloneError extends Error {
  readonly _tag = "TurnRestartAttachmentCloneError";

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "TurnRestartAttachmentCloneError";
  }
}

function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.makeUnsafe(String(value));
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function checkpointStatusFromRuntime(status: string | undefined): "ready" | "missing" | "error" {
  switch (status) {
    case "failed":
      return "error";
    case "cancelled":
    case "interrupted":
      return "missing";
    case "completed":
    default:
      return "ready";
  }
}

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore;
  const receiptBus = yield* RuntimeReceiptBus;
  const workspaceEntries = yield* WorkspaceEntries;
  const serverConfig = yield* ServerConfig;

  const appendRevertFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-revert-failure"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: "checkpoint.revert.failed",
        summary: "Checkpoint revert failed",
        payload: {
          turnCount: input.turnCount,
          detail: input.detail,
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const appendCaptureFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-capture-failure"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: "checkpoint.capture.failed",
        summary: "Checkpoint capture failed",
        payload: {
          detail: input.detail,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const appendRetryFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly assistantMessageId: MessageId;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("turn-retry-failure"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: "turn.retry.failed",
        summary: "Retry failed",
        payload: {
          assistantMessageId: input.assistantMessageId,
          detail: input.detail,
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const appendEditFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly userMessageId: MessageId;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("turn-edit-failure"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: "turn.edit.failed",
        summary: "Message edit failed",
        payload: {
          userMessageId: input.userMessageId,
          detail: input.detail,
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const failWithMessage = <A = never>(message: string): Effect.Effect<A, Error> =>
    Effect.fail(new Error(message));

  const resolveSessionRuntimeForThread = Effect.fnUntraced(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }>> {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);

    const sessions = yield* providerService.listSessions();

    const findSessionWithCwd = (
      session: (typeof sessions)[number] | undefined,
    ): Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }> => {
      if (!session?.cwd) {
        return Option.none();
      }
      return Option.some({ threadId: session.threadId, cwd: session.cwd });
    };

    if (thread) {
      const projectedSession = sessions.find((session) => session.threadId === thread.id);
      const fromProjected = findSessionWithCwd(projectedSession);
      if (Option.isSome(fromProjected)) {
        return fromProjected;
      }
    }

    return Option.none();
  });

  const isGitWorkspace = (cwd: string) => isGitRepository(cwd);

  // Resolves the workspace CWD for checkpoint operations, preferring the
  // active provider session CWD and falling back to the thread/project config.
  // Returns undefined when no CWD can be determined or the workspace is not
  // a git repository.
  const resolveCheckpointCwd = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: {
      readonly projectId: ProjectId | null;
      readonly projectlessCwd?: string | null | undefined;
      readonly worktreePath: string | null;
    };
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
    readonly preferSessionRuntime: boolean;
  }): Effect.fn.Return<string | undefined> {
    const fromSession = yield* resolveSessionRuntimeForThread(input.threadId);
    const fromThread = resolveThreadWorkspaceCwd({
      thread: input.thread,
      projects: input.projects,
    });

    const cwd = input.preferSessionRuntime
      ? (Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }) ?? fromThread)
      : (fromThread ??
        Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }));

    if (!cwd) {
      return undefined;
    }
    if (!isGitWorkspace(cwd)) {
      return undefined;
    }
    return cwd;
  });

  interface ResolvedTurnRestartTarget {
    readonly threadId: ThreadId;
    readonly turnCountBeforeRestart: number;
    readonly runtimeMode: "approval-required" | "full-access";
    readonly interactionMode: "default" | "plan";
    readonly message: {
      readonly text: string;
      readonly attachments: ReadonlyArray<ChatAttachment>;
    };
    readonly modelSelection?: ModelSelection;
    readonly titleSeed?: Extract<
      OrchestrationEvent,
      { type: "thread.turn-start-requested" }
    >["payload"]["titleSeed"];
    readonly sourceProposedPlan?: NonNullable<
      Extract<
        OrchestrationEvent,
        { type: "thread.turn-start-requested" }
      >["payload"]["sourceProposedPlan"]
    >;
  }

  // Anchors a turn restart either on the assistant message being retried or on
  // the user message being edited. Both resolve to the same shape: the user
  // message that started the turn plus the checkpoint turn count to rewind to.
  type TurnRestartAnchor =
    | { readonly kind: "assistant-message"; readonly messageId: MessageId }
    | { readonly kind: "user-message"; readonly messageId: MessageId };

  const cloneTurnRestartAttachments = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly attachments: ReadonlyArray<ChatAttachment>;
  }): Effect.fn.Return<ReadonlyArray<ChatAttachment>, Error> {
    if (input.attachments.length === 0) {
      return [];
    }

    return yield* Effect.forEach(input.attachments, (attachment) =>
      Effect.tryPromise({
        try: async () => {
          const nextId = createAttachmentId(input.threadId);
          if (!nextId) {
            throw new Error("Failed to allocate an attachment id for the restarted turn.");
          }

          const sourcePath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!sourcePath) {
            throw new Error(`Attachment '${attachment.id}' is unavailable for the restarted turn.`);
          }

          const nextAttachment = {
            ...attachment,
            id: nextId,
          } satisfies ChatAttachment;
          const targetPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: nextAttachment,
          });
          if (!targetPath) {
            throw new Error(`Failed to resolve an attachment path for '${attachment.id}'.`);
          }

          await mkdir(path.dirname(targetPath), { recursive: true });
          await copyFile(sourcePath, targetPath);
          return nextAttachment;
        },
        catch: (error) =>
          new TurnRestartAttachmentCloneError(
            error instanceof Error
              ? error.message
              : `Failed to clone attachment for the restarted turn: ${String(error)}`,
            error,
          ),
      }),
    );
  });

  const resolveTurnRestartTarget = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly anchor: TurnRestartAnchor;
  }): Effect.fn.Return<ResolvedTurnRestartTarget, Error | OrchestrationEventStoreError> {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === input.threadId);
    if (!thread) {
      return yield* failWithMessage("Thread was not found in read model.");
    }

    // boundaryIndex: messages at or after this index belong to the restarted
    // turn. anchorAssistantIndex: the assistant message whose checkpoint marks
    // the end of that turn (-1 when the turn never produced one).
    let boundaryIndex: number;
    let anchorAssistantIndex: number;
    let userMessage: (typeof thread.messages)[number] | undefined;

    if (input.anchor.kind === "assistant-message") {
      const anchorMessageId = input.anchor.messageId;
      const assistantIndex = thread.messages.findIndex(
        (message) => message.role === "assistant" && message.id === anchorMessageId,
      );
      if (assistantIndex === -1) {
        return yield* failWithMessage(
          `Assistant message '${anchorMessageId}' is unavailable for retry.`,
        );
      }
      userMessage = thread.messages
        .slice(0, assistantIndex)
        .toReversed()
        .find((message) => message.role === "user");
      if (!userMessage) {
        return yield* failWithMessage(
          `No preceding user message was found for assistant message '${anchorMessageId}'.`,
        );
      }
      boundaryIndex = assistantIndex;
      anchorAssistantIndex = assistantIndex;
    } else {
      const anchorMessageId = input.anchor.messageId;
      const userIndex = thread.messages.findIndex(
        (message) => message.role === "user" && message.id === anchorMessageId,
      );
      if (userIndex === -1) {
        return yield* failWithMessage(
          `User message '${anchorMessageId}' is unavailable for editing.`,
        );
      }
      userMessage = thread.messages[userIndex];
      // Mid-turn user messages (steering, user-input answers) carry a turnId
      // and never started a turn; restarting from one would drop the turn's
      // real prompt and replay the steer text as a top-level message.
      if (userMessage?.turnId) {
        return yield* failWithMessage(
          `User message '${anchorMessageId}' was sent mid-turn and cannot be edited.`,
        );
      }
      boundaryIndex = userIndex;
      anchorAssistantIndex = thread.messages.findIndex(
        (message, index) => index > userIndex && message.role === "assistant",
      );
    }
    if (!userMessage) {
      return yield* failWithMessage("User message was not found in read model.");
    }

    const anchorAssistantMessage =
      anchorAssistantIndex === -1 ? undefined : thread.messages[anchorAssistantIndex];
    const checkpoint = anchorAssistantMessage
      ? (thread.checkpoints.find(
          (entry) => entry.assistantMessageId === anchorAssistantMessage.id,
        ) ??
        (anchorAssistantMessage.turnId
          ? thread.checkpoints.find((entry) => entry.turnId === anchorAssistantMessage.turnId)
          : undefined))
      : undefined;

    const turnCountBeforeRestart = checkpoint
      ? Math.max(0, checkpoint.checkpointTurnCount - 1)
      : thread.checkpoints.reduce((maxTurnCount, candidateCheckpoint) => {
          const candidateAssistantIndex = candidateCheckpoint.assistantMessageId
            ? thread.messages.findIndex(
                (message) =>
                  message.role === "assistant" &&
                  message.id === candidateCheckpoint.assistantMessageId,
              )
            : candidateCheckpoint.turnId
              ? thread.messages.findIndex(
                  (message) =>
                    message.role === "assistant" && message.turnId === candidateCheckpoint.turnId,
                )
              : -1;
          if (candidateAssistantIndex === -1 || candidateAssistantIndex >= boundaryIndex) {
            return maxTurnCount;
          }
          return Math.max(maxTurnCount, candidateCheckpoint.checkpointTurnCount);
        }, 0);

    const events = yield* Stream.runCollect(orchestrationEngine.readEvents(0)).pipe(
      Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
    );
    const userMessageId = userMessage.id;
    const startEvent = events
      .toReversed()
      .find(
        (event): event is Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }> =>
          event.type === "thread.turn-start-requested" &&
          event.payload.threadId === input.threadId &&
          event.payload.messageId === userMessageId,
      );

    return {
      threadId: input.threadId,
      turnCountBeforeRestart,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      message: {
        text: userMessage.text,
        attachments: userMessage.attachments ?? [],
      },
      ...(startEvent?.payload.modelSelection !== undefined
        ? { modelSelection: startEvent.payload.modelSelection }
        : {}),
      ...(startEvent?.payload.titleSeed !== undefined
        ? { titleSeed: startEvent.payload.titleSeed }
        : {}),
      ...(startEvent?.payload.sourceProposedPlan !== undefined
        ? { sourceProposedPlan: startEvent.payload.sourceProposedPlan }
        : {}),
    };
  });

  const rewindThreadState = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly createdAt: string;
    readonly requireFilesystemRestore: boolean;
  }): Effect.fn.Return<
    void,
    Error | CheckpointStoreError | OrchestrationDispatchError | ProviderServiceError
  > {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === input.threadId);
    if (!thread) {
      return yield* failWithMessage("Thread was not found in read model.");
    }

    const hasActiveSession = (yield* providerService.listSessions()).some(
      (session) => session.threadId === input.threadId,
    );
    if (input.requireFilesystemRestore && !hasActiveSession) {
      return yield* failWithMessage("No active provider session is bound to this thread.");
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    if (input.turnCount > currentTurnCount) {
      return yield* failWithMessage(
        `Checkpoint turn count ${input.turnCount} exceeds current turn count ${currentTurnCount}.`,
      );
    }

    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId: input.threadId,
      thread,
      projects: readModel.projects,
      preferSessionRuntime: true,
    });

    if (checkpointCwd) {
      const targetCheckpointRef =
        input.turnCount === 0
          ? checkpointRefForThreadTurn(input.threadId, 0)
          : thread.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === input.turnCount,
            )?.checkpointRef;
      if (!targetCheckpointRef) {
        return yield* failWithMessage(
          `Checkpoint ref for turn ${input.turnCount} is unavailable in read model.`,
        );
      }

      const restored = yield* checkpointStore.restoreCheckpoint({
        cwd: checkpointCwd,
        checkpointRef: targetCheckpointRef,
        fallbackToHead: input.turnCount === 0,
      });
      if (!restored) {
        return yield* failWithMessage(
          `Filesystem checkpoint is unavailable for turn ${input.turnCount}.`,
        );
      }

      yield* workspaceEntries.invalidate(checkpointCwd);

      const staleCheckpointRefs = thread.checkpoints
        .filter((checkpoint) => checkpoint.checkpointTurnCount > input.turnCount)
        .map((checkpoint) => checkpoint.checkpointRef);
      if (staleCheckpointRefs.length > 0) {
        yield* checkpointStore.deleteCheckpointRefs({
          cwd: checkpointCwd,
          checkpointRefs: staleCheckpointRefs,
        });
      }
    } else if (input.requireFilesystemRestore) {
      return yield* failWithMessage("No checkpoint-capable workspace is bound to this thread.");
    }

    const rolledBackTurns = Math.max(0, currentTurnCount - input.turnCount);
    if (rolledBackTurns > 0) {
      yield* providerService.rollbackConversation({
        threadId: input.threadId,
        numTurns: rolledBackTurns,
      });
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.revert.complete",
      commandId: serverCommandId("checkpoint-revert-complete"),
      threadId: input.threadId,
      turnCount: input.turnCount,
      createdAt: input.createdAt,
    });
  });

  // Shared tail for retry and edit: rewind the thread to the turn boundary,
  // then start a fresh turn with the (possibly replaced) user message text.
  const restartTurn = Effect.fnUntraced(function* (input: {
    readonly target: ResolvedTurnRestartTarget;
    readonly text: string;
    readonly commandTag: string;
  }) {
    const restartAttachments = yield* cloneTurnRestartAttachments({
      threadId: input.target.threadId,
      attachments: input.target.message.attachments,
    });
    const restartCreatedAt = new Date().toISOString();

    yield* rewindThreadState({
      threadId: input.target.threadId,
      turnCount: input.target.turnCountBeforeRestart,
      createdAt: restartCreatedAt,
      requireFilesystemRestore: false,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: serverCommandId(input.commandTag),
      threadId: input.target.threadId,
      message: {
        messageId: MessageId.makeUnsafe(crypto.randomUUID()),
        role: "user",
        text: input.text,
        attachments: restartAttachments,
      },
      ...(input.target.modelSelection !== undefined
        ? { modelSelection: input.target.modelSelection }
        : {}),
      ...(input.target.titleSeed !== undefined ? { titleSeed: input.target.titleSeed } : {}),
      ...(input.target.sourceProposedPlan !== undefined
        ? { sourceProposedPlan: input.target.sourceProposedPlan }
        : {}),
      runtimeMode: input.target.runtimeMode,
      interactionMode: input.target.interactionMode,
      createdAt: restartCreatedAt,
    });
  });

  // Shared tail for both capture paths: creates the git checkpoint ref, diffs
  // it against the previous turn, then dispatches the domain events to update
  // the orchestration read model.
  const captureAndDispatchCheckpoint = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly thread: {
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly turnId: TurnId | null;
      }>;
      readonly activities: ReadonlyArray<CheckpointActivity>;
    };
    readonly cwd: string;
    readonly turnCount: number;
    readonly status: "ready" | "missing" | "error";
    readonly assistantMessageId: MessageId | undefined;
    readonly preferredFiles?: ReadonlyArray<{
      readonly path: string;
      readonly kind: string;
      readonly additions: number;
      readonly deletions: number;
    }>;
    readonly createdAt: string;
  }) {
    const fromTurnCount = Math.max(0, input.turnCount - 1);
    const fromCheckpointRef = checkpointRefForThreadTurn(input.threadId, fromTurnCount);
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);

    const fromCheckpointExists = yield* checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: fromCheckpointRef,
    });
    if (!fromCheckpointExists) {
      yield* Effect.logWarning("checkpoint capture missing pre-turn baseline", {
        threadId: input.threadId,
        turnId: input.turnId,
        fromTurnCount,
      });
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: input.cwd,
      checkpointRef: targetCheckpointRef,
    });

    // Invalidate the workspace entry cache so the @-mention file picker
    // reflects files created or deleted during this turn.
    yield* workspaceEntries.invalidate(input.cwd);

    const derivedFiles = yield* checkpointStore
      .diffCheckpoints({
        cwd: input.cwd,
        fromCheckpointRef,
        toCheckpointRef: targetCheckpointRef,
        fallbackFromToHead: false,
      })
      .pipe(
        Effect.map((diff) =>
          parseTurnDiffFilesFromUnifiedDiff(diff).map((file) => ({
            path: file.path,
            kind: "modified" as const,
            additions: file.additions,
            deletions: file.deletions,
          })),
        ),
        Effect.tapError((error) =>
          appendCaptureFailureActivity({
            threadId: input.threadId,
            turnId: input.turnId,
            detail: `Checkpoint captured, but turn diff summary is unavailable: ${error.message}`,
            createdAt: input.createdAt,
          }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("failed to derive checkpoint file summary", {
            threadId: input.threadId,
            turnId: input.turnId,
            turnCount: input.turnCount,
            detail: error.message,
          }).pipe(Effect.as([])),
        ),
      );
    const files = selectThreadScopedCheckpointFiles({
      activities: input.thread.activities,
      turnId: input.turnId,
      derivedFiles,
      ...(input.preferredFiles !== undefined ? { preferredFiles: input.preferredFiles } : {}),
    });

    const assistantMessageId =
      input.assistantMessageId ??
      input.thread.messages
        .toReversed()
        .find((entry) => entry.role === "assistant" && entry.turnId === input.turnId)?.id ??
      MessageId.makeUnsafe(`assistant:${input.turnId}`);

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: serverCommandId("checkpoint-turn-diff-complete"),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.createdAt,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      files,
      assistantMessageId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "checkpoint.diff.finalized",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "turn.processing.quiesced",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-captured-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "info",
        kind: "checkpoint.captured",
        summary: "Checkpoint captured",
        payload: {
          turnCount: input.turnCount,
          status: input.status,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  // Captures a real git checkpoint when a turn completes via a runtime event.
  const captureCheckpointFromTurnCompletion = Effect.fnUntraced(function* (
    event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
  ) {
    const turnId = toTurnId(event.turnId);
    if (!turnId) {
      return;
    }

    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === event.threadId);
    if (!thread) {
      return;
    }

    // When a primary turn is active, only that turn may produce completion checkpoints.
    if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
      return;
    }

    // Only skip if a real (non-placeholder) checkpoint already exists for this turn.
    // ProviderRuntimeIngestion may insert placeholder entries with status "missing"
    // before this reactor runs; those must not prevent real git capture.
    if (
      thread.checkpoints.some(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
      )
    ) {
      return;
    }

    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId: thread.id,
      thread,
      projects: readModel.projects,
      preferSessionRuntime: true,
    });
    if (!checkpointCwd) {
      return;
    }

    // If a placeholder checkpoint exists for this turn, reuse its turn count
    // instead of incrementing past it.
    const existingPlaceholder = thread.checkpoints.find(
      (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing",
    );
    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const nextTurnCount = existingPlaceholder
      ? existingPlaceholder.checkpointTurnCount
      : currentTurnCount + 1;

    yield* captureAndDispatchCheckpoint({
      threadId: thread.id,
      turnId,
      thread,
      cwd: checkpointCwd,
      turnCount: nextTurnCount,
      status: checkpointStatusFromRuntime(event.payload.state),
      assistantMessageId: undefined,
      ...(existingPlaceholder?.files ? { preferredFiles: existingPlaceholder.files } : {}),
      createdAt: event.createdAt,
    });
  });

  // Captures a real git checkpoint when a placeholder checkpoint (status "missing")
  // is detected via a domain event. This replaces the placeholder with a real
  // git-ref-based checkpoint.
  //
  // ProviderRuntimeIngestion creates placeholder checkpoints on turn.diff.updated
  // events from the Codex runtime. This handler fires when the corresponding
  // domain event arrives, allowing the reactor to capture the actual filesystem
  // state into a git ref and dispatch a replacement checkpoint.
  const captureCheckpointFromPlaceholder = Effect.fnUntraced(function* (
    event: Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }>,
  ) {
    const { threadId, turnId, checkpointTurnCount, status } = event.payload;

    // Only replace placeholders; skip events from our own real captures.
    if (status !== "missing") {
      return;
    }

    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      yield* Effect.logWarning("checkpoint capture from placeholder skipped: thread not found", {
        threadId,
      });
      return;
    }

    // If a real checkpoint already exists for this turn, skip.
    if (
      thread.checkpoints.some(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
      )
    ) {
      yield* Effect.logDebug(
        "checkpoint capture from placeholder skipped: real checkpoint already exists",
        { threadId, turnId },
      );
      return;
    }

    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects: readModel.projects,
      preferSessionRuntime: true,
    });
    if (!checkpointCwd) {
      return;
    }

    yield* captureAndDispatchCheckpoint({
      threadId,
      turnId,
      thread,
      cwd: checkpointCwd,
      turnCount: checkpointTurnCount,
      status: "ready",
      assistantMessageId: event.payload.assistantMessageId ?? undefined,
      ...(event.payload.files.length > 0 ? { preferredFiles: event.payload.files } : {}),
      createdAt: event.payload.completedAt,
    });
  });

  const ensurePreTurnBaselineFromTurnStart = Effect.fnUntraced(function* (
    event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>,
  ) {
    const turnId = toTurnId(event.turnId);
    if (!turnId) {
      return;
    }

    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === event.threadId);
    if (!thread) {
      return;
    }

    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId: thread.id,
      thread,
      projects: readModel.projects,
      preferSessionRuntime: false,
    });
    if (!checkpointCwd) {
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const baselineCheckpointRef = checkpointRefForThreadTurn(thread.id, currentTurnCount);
    const baselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    if (baselineExists) {
      return;
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    yield* receiptBus.publish({
      type: "checkpoint.baseline.captured",
      threadId: thread.id,
      checkpointTurnCount: currentTurnCount,
      checkpointRef: baselineCheckpointRef,
      createdAt: event.createdAt,
    });
  });

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fnUntraced(function* (
    event: Extract<
      OrchestrationEvent,
      { type: "thread.turn-start-requested" | "thread.message-sent" }
    >,
  ) {
    if (event.type === "thread.message-sent") {
      if (
        event.payload.role !== "user" ||
        event.payload.streaming ||
        event.payload.turnId !== null
      ) {
        return;
      }
    }

    const threadId = event.payload.threadId;
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return;
    }

    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects: readModel.projects,
      preferSessionRuntime: false,
    });
    if (!checkpointCwd) {
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const baselineCheckpointRef = checkpointRefForThreadTurn(threadId, currentTurnCount);
    const baselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    if (baselineExists) {
      return;
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    yield* receiptBus.publish({
      type: "checkpoint.baseline.captured",
      threadId,
      checkpointTurnCount: currentTurnCount,
      checkpointRef: baselineCheckpointRef,
      createdAt: event.occurredAt,
    });
  });

  const handleRevertRequested = Effect.fnUntraced(function* (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
  ) {
    yield* rewindThreadState({
      threadId: event.payload.threadId,
      turnCount: event.payload.turnCount,
      createdAt: new Date().toISOString(),
      requireFilesystemRestore: true,
    });
  });

  const handleRetryRequested = Effect.fnUntraced(function* (
    event: Extract<OrchestrationEvent, { type: "thread.turn-retry-requested" }>,
  ) {
    const retryTarget = yield* resolveTurnRestartTarget({
      threadId: event.payload.threadId,
      anchor: { kind: "assistant-message", messageId: event.payload.assistantMessageId },
    });
    yield* restartTurn({
      target: retryTarget,
      text: retryTarget.message.text,
      commandTag: "turn-retry-start",
    });
  });

  const handleEditRequested = Effect.fnUntraced(function* (
    event: Extract<OrchestrationEvent, { type: "thread.turn-edit-requested" }>,
  ) {
    const editTarget = yield* resolveTurnRestartTarget({
      threadId: event.payload.threadId,
      anchor: { kind: "user-message", messageId: event.payload.userMessageId },
    });
    yield* restartTurn({
      target: editTarget,
      text: event.payload.text,
      commandTag: "turn-edit-start",
    });
  });

  const processDomainEvent = Effect.fnUntraced(function* (event: OrchestrationEvent) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      yield* handleRevertRequested(event).pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
            createdAt: new Date().toISOString(),
          }),
        ),
      );
      return;
    }

    if (event.type === "thread.turn-retry-requested") {
      yield* handleRetryRequested(event).pipe(
        Effect.catch((error) =>
          appendRetryFailureActivity({
            threadId: event.payload.threadId,
            assistantMessageId: event.payload.assistantMessageId,
            detail: error.message,
            createdAt: new Date().toISOString(),
          }),
        ),
      );
      return;
    }

    if (event.type === "thread.turn-edit-requested") {
      yield* handleEditRequested(event).pipe(
        Effect.catch((error) =>
          appendEditFailureActivity({
            threadId: event.payload.threadId,
            userMessageId: event.payload.userMessageId,
            detail: error.message,
            createdAt: new Date().toISOString(),
          }),
        ),
      );
      return;
    }

    // When ProviderRuntimeIngestion creates a placeholder checkpoint (status "missing")
    // from a turn.diff.updated runtime event, capture the real git checkpoint to
    // replace it. The providerService.streamEvents PubSub does not reliably deliver
    // turn.completed runtime events to this reactor (shared subscription), so
    // reacting to the domain event is the reliable path.
    if (event.type === "thread.turn-diff-completed") {
      yield* captureCheckpointFromPlaceholder(event).pipe(
        Effect.catch((error) =>
          appendCaptureFailureActivity({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            detail: error.message,
            createdAt: new Date().toISOString(),
          }).pipe(Effect.catch(() => Effect.void)),
        ),
      );
    }
  });

  const processRuntimeEvent = Effect.fnUntraced(function* (event: ProviderRuntimeEvent) {
    if (event.type === "turn.started") {
      yield* ensurePreTurnBaselineFromTurnStart(event);
      return;
    }

    if (event.type === "turn.completed") {
      const turnId = toTurnId(event.turnId);
      yield* captureCheckpointFromTurnCompletion(event).pipe(
        Effect.catch((error) =>
          appendCaptureFailureActivity({
            threadId: event.threadId,
            turnId,
            detail: error.message,
            createdAt: new Date().toISOString(),
          }).pipe(Effect.catch(() => Effect.void)),
        ),
      );
      return;
    }
  });

  const processInput = (
    input: ReactorInput,
  ): Effect.Effect<void, CheckpointStoreError | OrchestrationDispatchError, never> =>
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("checkpoint reactor failed to process input", {
          source: input.source,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: CheckpointReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.checkpoint-revert-requested" &&
          event.type !== "thread.turn-retry-requested" &&
          event.type !== "thread.turn-edit-requested" &&
          event.type !== "thread.turn-diff-completed"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (event.type !== "turn.started" && event.type !== "turn.completed") {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make);
