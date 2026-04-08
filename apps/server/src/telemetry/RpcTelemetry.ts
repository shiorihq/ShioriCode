import type { ClientOrchestrationCommand, OrchestrationCommand } from "contracts/orchestration";
import type { ServerSettingsPatch } from "contracts/settings";
import type { TelemetryProperties } from "contracts/telemetry";

function compactProperties(properties: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));
}

export function withTelemetrySource(
  source: string,
  properties?: TelemetryProperties,
): Readonly<Record<string, unknown>> {
  return compactProperties({
    source,
    ...properties,
  });
}

export function summarizeSettingsPatch(
  patch: ServerSettingsPatch,
): Readonly<Record<string, unknown>> {
  const patchKeys = Object.keys(patch).toSorted();
  return compactProperties({
    patchKeys,
    patchKeyCount: patchKeys.length,
  });
}

export function summarizeClientCommand(
  command: ClientOrchestrationCommand | OrchestrationCommand,
): Readonly<Record<string, unknown>> {
  switch (command.type) {
    case "project.create":
      return compactProperties({
        commandType: command.type,
        hasDefaultModelSelection: command.defaultModelSelection !== undefined,
      });
    case "project.meta.update":
      return compactProperties({
        commandType: command.type,
        updatedKeys: Object.keys(command).filter(
          (key) => !["type", "commandId", "projectId"].includes(key),
        ),
      });
    case "thread.create":
      return compactProperties({
        commandType: command.type,
        provider: command.modelSelection.provider,
        runtimeMode: command.runtimeMode,
        interactionMode: command.interactionMode,
        branched: command.parentThreadId != null,
        hasSeedMessages: (command.seedMessages?.length ?? 0) > 0,
        hasTag: command.tag != null,
        hasWorktreePath: command.worktreePath != null,
      });
    case "thread.meta.update":
      return compactProperties({
        commandType: command.type,
        updatedKeys: Object.keys(command).filter(
          (key) => !["type", "commandId", "threadId"].includes(key),
        ),
      });
    case "thread.runtime-mode.set":
      return compactProperties({
        commandType: command.type,
        runtimeMode: command.runtimeMode,
      });
    case "thread.interaction-mode.set":
      return compactProperties({
        commandType: command.type,
        interactionMode: command.interactionMode,
      });
    case "thread.turn.start":
      return compactProperties({
        commandType: command.type,
        provider: command.modelSelection?.provider,
        runtimeMode: command.runtimeMode,
        interactionMode: command.interactionMode,
        promptLength: command.message.text.length,
        attachmentCount: command.message.attachments.length,
        hasTitleSeed: command.titleSeed !== undefined,
        fromProposedPlan: command.sourceProposedPlan !== undefined,
      });
    case "thread.approval.respond":
      return compactProperties({
        commandType: command.type,
        decision:
          typeof command.decision === "string" ? command.decision : "acceptWithExecpolicyAmendment",
      });
    case "thread.user-input.respond":
      return compactProperties({
        commandType: command.type,
        answerCount: Object.keys(command.answers).length,
      });
    case "thread.checkpoint.revert":
      return compactProperties({
        commandType: command.type,
        turnCount: command.turnCount,
      });
    default:
      return compactProperties({
        commandType: command.type,
      });
  }
}
