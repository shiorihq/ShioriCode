import { CommandId, type KanbanItem, type OrchestrationEvent } from "contracts";
import { Cause, Effect, Layer, Stream } from "effect";
import { makeDrainableWorker } from "shared/DrainableWorker";

import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  KanbanPromptReactor,
  type KanbanPromptReactorShape,
} from "../Services/KanbanPromptReactor.ts";

type KanbanPromptEvent = Extract<
  OrchestrationEvent,
  { type: "kanbanItem.created" | "kanbanItem.updated" }
>;

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

function toErrorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return String(cause);
}

function fallbackPrompt(item: KanbanItem): string {
  if (item.prompt.trim().length > 0) {
    return item.prompt.trim();
  }
  return [
    `- Clarify the current implementation related to ${item.title}`,
    "- Identify the smallest reliable implementation path",
    "- Make the scoped code changes",
    "- Validate behavior with checks or focused tests",
    "- Summarize changes, risks, and follow-up work",
  ].join("\n");
}

const makeKanbanPromptReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const serverSettings = yield* ServerSettingsService;
  const textGeneration = yield* TextGeneration;

  const dispatchUpdate = (item: KanbanItem, patch: Partial<KanbanItem>, updatedAt: string) =>
    orchestrationEngine.dispatch({
      type: "kanbanItem.update",
      commandId: serverCommandId("kanban-prompt"),
      itemId: item.id,
      ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
      ...(patch.generatedPrompt !== undefined ? { generatedPrompt: patch.generatedPrompt } : {}),
      ...(patch.promptStatus !== undefined ? { promptStatus: patch.promptStatus } : {}),
      ...(patch.promptError !== undefined ? { promptError: patch.promptError } : {}),
      updatedAt,
    });

  const processEvent = Effect.fn("processKanbanPromptEvent")(function* (event: KanbanPromptEvent) {
    if (event.type === "kanbanItem.created") {
      const settings = yield* serverSettings.getSettings;
      if (!settings.autoGenerateKanbanTaskPrompts) {
        return;
      }
      const item = event.payload.item;
      if (item.deletedAt !== null || item.promptStatus !== "idle") {
        return;
      }
      yield* dispatchUpdate(
        item,
        { promptStatus: "generating", promptError: null, generatedPrompt: null },
        new Date().toISOString(),
      );
      return;
    }

    if (event.payload.promptStatus !== "generating") {
      return;
    }

    const settings = yield* serverSettings.getSettings;
    const readModel = yield* orchestrationEngine.getReadModel();
    const item = (readModel.kanbanItems ?? []).find((entry) => entry.id === event.payload.itemId);
    if (!item || item.deletedAt !== null || item.promptStatus !== "generating") {
      return;
    }

    const project = readModel.projects.find(
      (entry) => entry.id === item.projectId && entry.deletedAt === null,
    );
    if (!project) {
      return;
    }

    const generated = yield* textGeneration
      .generateKanbanTaskPrompt({
        cwd: project.workspaceRoot,
        title: item.title,
        description: item.description,
        prompt: item.prompt,
        pullRequest: item.pullRequest,
        modelSelection: settings.textGenerationModelSelection,
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.succeed({
            prompt: fallbackPrompt(item),
            error: toErrorMessage(cause),
          }),
        ),
      );

    const completedAt = new Date().toISOString();
    yield* dispatchUpdate(
      item,
      "error" in generated
        ? {
            generatedPrompt: generated.prompt,
            promptStatus: "failed",
            promptError: generated.error,
          }
        : {
            generatedPrompt: generated.prompt,
            promptStatus: "ready",
            promptError: null,
          },
      completedAt,
    );
  });

  const processEventSafely = (event: KanbanPromptEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("kanban prompt reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);

  const start: KanbanPromptReactorShape["start"] = Effect.fn("startKanbanPromptReactor")(
    function* () {
      yield* Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          if (event.type !== "kanbanItem.created" && event.type !== "kanbanItem.updated") {
            return Effect.void;
          }
          return worker.enqueue(event);
        }),
      );
    },
  );

  return {
    start,
    drain: worker.drain,
  } satisfies KanbanPromptReactorShape;
});

export const KanbanPromptReactorLive = Layer.effect(KanbanPromptReactor, makeKanbanPromptReactor);
