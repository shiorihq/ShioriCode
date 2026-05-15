import {
  AutomationError,
  AutomationId,
  CommandId,
  MessageId,
  ThreadId,
  type Automation,
  type AutomationCreateInput,
} from "contracts";
import { Cause, Duration, Effect, Layer, Option } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { AutomationRepository } from "../Services/AutomationRepository.ts";
import { AutomationService, type AutomationServiceShape } from "../Services/AutomationService.ts";
import {
  AutomationScheduleError,
  computeNextAutomationRunAt,
  parseAutomationRrule,
} from "../schedule.ts";
import { AUTOMATION_THREAD_TAG, hasActiveAutomationTurn } from "../threadIdentity.ts";

const POLL_INTERVAL = Duration.seconds(30);

function automationError(message: string, cause?: unknown): AutomationError {
  return new AutomationError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function formatUnknownCause(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  if (typeof cause === "string" && cause.trim().length > 0) {
    return cause.trim();
  }
  return "Unknown automation failure.";
}

function validateRrule(rrule: string) {
  parseAutomationRrule(rrule);
}

function toListResult(automations: ReadonlyArray<Automation>) {
  return { automations: [...automations] };
}

function createAutomation(input: AutomationCreateInput, now: string): Automation {
  validateRrule(input.scheduleRrule);
  const status = input.status ?? "active";
  const interactionMode = input.interactionMode ?? "default";
  return {
    id: AutomationId.makeUnsafe(crypto.randomUUID()),
    kind: "automation",
    title: input.title,
    prompt: input.prompt,
    projectId: input.projectId,
    projectlessCwd: input.projectlessCwd ?? null,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode,
    scheduleRrule: input.scheduleRrule,
    status,
    nextRunAt:
      status === "active" ? computeNextAutomationRunAt(input.scheduleRrule, new Date(now)) : null,
    lastRunAt: null,
    lastRunThreadId: null,
    lastRunStatus: "idle",
    lastRunError: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

const makeAutomationService = Effect.gen(function* () {
  const repository = yield* AutomationRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;

  const listResult = repository.list().pipe(
    Effect.map(toListResult),
    Effect.mapError((cause) => automationError("Failed to load automations.", cause)),
  );

  const getExisting = (automationId: Automation["id"]) =>
    repository.getById(automationId).pipe(
      Effect.mapError((cause) => automationError("Failed to load automation.", cause)),
      Effect.flatMap((automation) =>
        Option.match(automation, {
          onNone: () => Effect.fail(automationError("Automation was not found.")),
          onSome: Effect.succeed,
        }),
      ),
    );

  const updateAutomationRow = (automation: Automation) =>
    repository
      .upsert(automation)
      .pipe(Effect.mapError((cause) => automationError("Failed to persist automation.", cause)));

  const queueAutomationTurn = Effect.fn("queueAutomationTurn")(function* (
    automation: Automation,
    queuedAt: string,
  ) {
    const threadId = ThreadId.makeUnsafe(
      `automation-thread:${automation.id}:${crypto.randomUUID()}`,
    );

    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe(
        `automation-thread-create:${automation.id}:${crypto.randomUUID()}`,
      ),
      threadId,
      projectId: automation.projectId,
      projectlessCwd: automation.projectlessCwd,
      title: automation.title,
      modelSelection: automation.modelSelection,
      runtimeMode: automation.runtimeMode,
      interactionMode: automation.interactionMode,
      branch: null,
      worktreePath: null,
      tag: AUTOMATION_THREAD_TAG,
      createdAt: queuedAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe(`automation:${automation.id}:${crypto.randomUUID()}`),
      threadId,
      message: {
        messageId: MessageId.makeUnsafe(
          `automation-message:${automation.id}:${crypto.randomUUID()}`,
        ),
        role: "user",
        text: automation.prompt,
        attachments: [],
      },
      modelSelection: automation.modelSelection,
      runtimeMode: automation.runtimeMode,
      interactionMode: automation.interactionMode,
      titleSeed: automation.title,
      createdAt: queuedAt,
    });
    return threadId;
  });

  const markQueued = Effect.fn("markQueued")(function* (automation: Automation, queuedAt: string) {
    const threadId = yield* queueAutomationTurn(automation, queuedAt);
    const nextAutomation: Automation = {
      ...automation,
      nextRunAt:
        automation.status === "active"
          ? computeNextAutomationRunAt(automation.scheduleRrule, new Date(queuedAt))
          : null,
      lastRunAt: queuedAt,
      lastRunThreadId: threadId,
      lastRunStatus: "queued",
      lastRunError: null,
      updatedAt: queuedAt,
    };
    yield* updateAutomationRow(nextAutomation);
    return nextAutomation;
  });

  const markFailed = Effect.fn("markFailed")(function* (
    automation: Automation,
    failedAt: string,
    cause: unknown,
  ) {
    const nextAutomation: Automation = {
      ...automation,
      nextRunAt:
        automation.status === "active"
          ? computeNextAutomationRunAt(automation.scheduleRrule, new Date(failedAt))
          : null,
      lastRunAt: failedAt,
      lastRunStatus: "failed",
      lastRunError: formatUnknownCause(cause),
      updatedAt: failedAt,
    };
    yield* updateAutomationRow(nextAutomation);
    return nextAutomation;
  });

  const runAutomation = Effect.fn("runAutomation")(function* (automation: Automation) {
    if (automation.lastRunThreadId) {
      const readModel = yield* orchestrationEngine.getReadModel();
      const lastRunThread = readModel.threads.find(
        (thread) => thread.id === automation.lastRunThreadId,
      );
      if (lastRunThread && hasActiveAutomationTurn(lastRunThread)) {
        yield* Effect.logDebug("automation run skipped because previous run is still active", {
          automationId: automation.id,
          threadId: automation.lastRunThreadId,
        });
        return;
      }
    }

    const queuedAt = new Date().toISOString();
    yield* markQueued(automation, queuedAt).pipe(
      Effect.catch((cause) => markFailed(automation, queuedAt, cause)),
    );
  });

  const processDueAutomations = Effect.gen(function* () {
    const dueAutomations = yield* repository
      .listDue(new Date().toISOString())
      .pipe(Effect.mapError((cause) => automationError("Failed to load due automations.", cause)));
    yield* Effect.forEach(dueAutomations, runAutomation, { concurrency: 1 });
  });

  const start: AutomationServiceShape["start"] = Effect.forkScoped(
    Effect.forever(
      processDueAutomations.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("automation scheduler tick failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.andThen(Effect.sleep(POLL_INTERVAL)),
      ),
    ),
  ).pipe(Effect.asVoid);

  const create: AutomationServiceShape["create"] = (input) =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const automation = yield* Effect.try({
        try: () => createAutomation(input, now),
        catch: (cause) =>
          cause instanceof AutomationScheduleError
            ? automationError(cause.message, cause)
            : automationError("Failed to create automation.", cause),
      });
      yield* updateAutomationRow(automation);
      return yield* listResult;
    });

  const update: AutomationServiceShape["update"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* getExisting(input.automationId);
      const inputScheduleRrule = input.scheduleRrule;
      if (inputScheduleRrule !== undefined) {
        yield* Effect.try({
          try: () => validateRrule(inputScheduleRrule),
          catch: (cause) =>
            cause instanceof AutomationScheduleError
              ? automationError(cause.message, cause)
              : automationError("Failed to update automation schedule.", cause),
        });
      }
      const nextStatus = input.status ?? existing.status;
      const nextScheduleRrule = input.scheduleRrule ?? existing.scheduleRrule;
      const now = new Date().toISOString();
      const nextRunAt =
        nextStatus === "active"
          ? yield* Effect.try({
              try: () => computeNextAutomationRunAt(nextScheduleRrule),
              catch: (cause) =>
                cause instanceof AutomationScheduleError
                  ? automationError(cause.message, cause)
                  : automationError("Failed to update automation schedule.", cause),
            })
          : null;
      const nextAutomation: Automation = {
        ...existing,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        ...(input.projectlessCwd !== undefined ? { projectlessCwd: input.projectlessCwd } : {}),
        ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
        ...(input.runtimeMode !== undefined ? { runtimeMode: input.runtimeMode } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
        scheduleRrule: nextScheduleRrule,
        status: nextStatus,
        nextRunAt,
        lastRunError: null,
        updatedAt: now,
      };
      yield* updateAutomationRow(nextAutomation);
      return yield* listResult;
    });

  const deleteAutomation: AutomationServiceShape["delete"] = (input) =>
    Effect.gen(function* () {
      const deletedAt = new Date().toISOString();
      yield* repository
        .softDelete({ automationId: input.automationId, deletedAt })
        .pipe(Effect.mapError((cause) => automationError("Failed to delete automation.", cause)));
      return yield* listResult;
    });

  const runNow: AutomationServiceShape["runNow"] = (input) =>
    Effect.gen(function* () {
      const automation = yield* getExisting(input.automationId);
      yield* runAutomation(automation);
      return yield* listResult;
    });

  return {
    list: listResult,
    create,
    update,
    delete: deleteAutomation,
    runNow,
    start,
  } satisfies AutomationServiceShape;
});

export const AutomationServiceLive = Layer.effect(AutomationService, makeAutomationService);
