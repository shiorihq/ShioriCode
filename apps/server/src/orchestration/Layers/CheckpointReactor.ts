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

class RetryAttachmentCloneError extends Error {
  readonly _tag = "RetryAttachmentCloneError";

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "RetryAttachmentCloneError";
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

  interface ResolvedRetryTarget {
    readonly threadId: ThreadId;
    readonly assistantMessageId: MessageId;
    readonly turnCountBeforeRetry: number;
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

  const cloneRetryAttachments = Effect.fnUntraced(function* (input: {
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
            throw new Error("Failed to allocate a retry attachment id.");
          }

          const sourcePath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!sourcePath) {
            throw new Error(`Attachment '${attachment.id}' is unavailable for retry.`);
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
            throw new Error(`Failed to resolve a retry attachment path for '${attachment.id}'.`);
          }

          await mkdir(path.dirname(targetPath), { recursive: true });
          await copyFile(sourcePath, targetPath);
          return nextAttachment;
        },
        catch: (error) =>
          new RetryAttachmentCloneError(
            error instanceof Error
              ? error.message
              : `Failed to clone retry attachment: ${String(error)}`,
            error,
          ),
      }),
    );
  });

  const resolveRetryTarget = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly assistantMessageId: MessageId;
  }): Effect.fn.Return<ResolvedRetryTarget, Error | OrchestrationEventStoreError> {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === input.threadId);
    if (!thread) {
      return yield* failWithMessage("Thread was not found in read model.");
    }

    const assistantIndex = thread.messages.findIndex(
      (message) => message.role === "assistant" && message.id === input.assistantMessageId,
    );
    if (assistantIndex === -1) {
      return yield* failWithMessage(
        `Assistant message '${input.assistantMessageId}' is unavailable for retry.`,
      );
    }

    const userMessage = thread.messages
      .slice(0, assistantIndex)
      .toReversed()
      .find((message) => message.role === "user");
    if (!userMessage) {
      return yield* failWithMessage(
        `No preceding user message was found for assistant message '${input.assistantMessageId}'.`,
      );
    }

    const checkpoint =
      thread.checkpoints.find((entry) => entry.assistantMessageId === input.assistantMessageId) ??
      (thread.messages[assistantIndex]?.turnId
        ? thread.checkpoints.find(
            (entry) => entry.turnId === thread.messages[assistantIndex]?.turnId,
          )
        : undefined);

    const turnCountBeforeRetry = checkpoint
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
          if (candidateAssistantIndex === -1 || candidateAssistantIndex >= assistantIndex) {
            return maxTurnCount;
          }
          return Math.max(maxTurnCount, candidateCheckpoint.checkpointTurnCount);
        }, 0);

    const events = yield* Stream.runCollect(orchestrationEngine.readEvents(0)).pipe(
      Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
    );
    const startEvent = events
      .toReversed()
      .find(
        (event): event is Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }> =>
          event.type === "thread.turn-start-requested" &&
          event.payload.threadId === input.threadId &&
          event.payload.messageId === userMessage.id,
      );

    return {
      threadId: input.threadId,
      assistantMessageId: input.assistantMessageId,
      turnCountBeforeRetry,
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
    const files =
      input.preferredFiles && input.preferredFiles.length > 0 ? input.preferredFiles : derivedFiles;

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
    const retryTarget = yield* resolveRetryTarget({
      threadId: event.payload.threadId,
      assistantMessageId: event.payload.assistantMessageId,
    });
    const retryAttachments = yield* cloneRetryAttachments({
      threadId: retryTarget.threadId,
      attachments: retryTarget.message.attachments,
    });
    const retryCreatedAt = new Date().toISOString();

    yield* rewindThreadState({
      threadId: retryTarget.threadId,
      turnCount: retryTarget.turnCountBeforeRetry,
      createdAt: retryCreatedAt,
      requireFilesystemRestore: false,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: serverCommandId("turn-retry-start"),
      threadId: retryTarget.threadId,
      message: {
        messageId: MessageId.makeUnsafe(crypto.randomUUID()),
        role: "user",
        text: retryTarget.message.text,
        attachments: retryAttachments,
      },
      ...(retryTarget.modelSelection !== undefined
        ? { modelSelection: retryTarget.modelSelection }
        : {}),
      ...(retryTarget.titleSeed !== undefined ? { titleSeed: retryTarget.titleSeed } : {}),
      ...(retryTarget.sourceProposedPlan !== undefined
        ? { sourceProposedPlan: retryTarget.sourceProposedPlan }
        : {}),
      runtimeMode: retryTarget.runtimeMode,
      interactionMode: retryTarget.interactionMode,
      createdAt: retryCreatedAt,
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
