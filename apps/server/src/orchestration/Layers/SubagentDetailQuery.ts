import { open as openFile } from "node:fs/promises";
import path from "node:path";

import type {
  OrchestrationThread,
  OrchestrationThreadActivity,
  ProviderKind,
  OrchestrationSubagentTranscriptEntry,
} from "contracts/orchestration";
import type { TurnId } from "contracts";
import { Effect, Layer } from "effect";

import { resolvePreferredCodexBinaryPath } from "../../provider/codexBinaryPath.ts";
import { readCodexStoredThread } from "../../provider/codexStoredThread.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  SubagentDetailQuery,
  type SubagentDetailQueryShape,
} from "../Services/SubagentDetailQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";

const MAX_CLAUDE_OUTPUT_PREVIEW_BYTES = 200_000;

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((entry) => asTrimmedString(entry))
        .filter((entry): entry is string => entry !== null)
    : [];
}

function activityPayload(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return asObject(activity.payload);
}

function activityItemId(activity: OrchestrationThreadActivity): string | null {
  return asTrimmedString(activityPayload(activity)?.itemId);
}

function activityParentItemId(activity: OrchestrationThreadActivity): string | null {
  return asTrimmedString(activityPayload(activity)?.parentItemId);
}

function activityItemType(activity: OrchestrationThreadActivity): string | null {
  return asTrimmedString(activityPayload(activity)?.itemType);
}

function compareActivities(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  const leftSequence = typeof left.sequence === "number" ? left.sequence : Number.MAX_SAFE_INTEGER;
  const rightSequence =
    typeof right.sequence === "number" ? right.sequence : Number.MAX_SAFE_INTEGER;
  return (
    leftSequence - rightSequence ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function collectSubagentActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  rootItemId: string,
): OrchestrationThreadActivity[] {
  const ordered = [...activities].toSorted(compareActivities);
  const descendantItemIds = new Set<string>([rootItemId]);
  let changed = true;

  while (changed) {
    changed = false;
    for (const activity of ordered) {
      const itemId = activityItemId(activity);
      const parentItemId = activityParentItemId(activity);
      if (!itemId || !parentItemId) {
        continue;
      }
      if (descendantItemIds.has(parentItemId) && !descendantItemIds.has(itemId)) {
        descendantItemIds.add(itemId);
        changed = true;
      }
    }
  }

  return ordered.filter((activity) => {
    const itemId = activityItemId(activity);
    const parentItemId = activityParentItemId(activity);
    return (
      itemId === rootItemId ||
      (itemId !== null && descendantItemIds.has(itemId)) ||
      (parentItemId !== null && descendantItemIds.has(parentItemId))
    );
  });
}

function pickRootActivity(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  rootItemId: string,
): OrchestrationThreadActivity | null {
  const matches = activities.filter(
    (activity) =>
      activityItemId(activity) === rootItemId &&
      activityItemType(activity) === "collab_agent_tool_call",
  );
  return matches.length > 0 ? (matches[matches.length - 1] ?? null) : null;
}

function activityData(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return asObject(activityPayload(activity)?.data);
}

function subagentInputRecord(
  activity: OrchestrationThreadActivity,
): Record<string, unknown> | null {
  const data = activityData(activity);
  return asObject(data?.input) ?? asObject(asObject(data?.item)?.input);
}

function subagentResultRecord(
  activity: OrchestrationThreadActivity,
): Record<string, unknown> | null {
  const data = activityData(activity);
  return asObject(data?.result) ?? asObject(asObject(data?.item)?.result);
}

function extractContentText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const parts = value
    .map((entry) => {
      const block = asObject(entry);
      return asTrimmedString(block?.text) ?? asTrimmedString(block?.content);
    })
    .filter((entry): entry is string => entry !== null);
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n\n");
}

function extractSubagentMetadata(activity: OrchestrationThreadActivity) {
  const input = subagentInputRecord(activity);
  const result = subagentResultRecord(activity);
  const description =
    asTrimmedString(input?.description) ??
    asTrimmedString(input?.task) ??
    asTrimmedString(input?.name) ??
    null;
  const prompt = asTrimmedString(input?.prompt) ?? null;
  const agentType =
    asTrimmedString(input?.subagent_type) ??
    asTrimmedString(input?.subagentType) ??
    asTrimmedString(input?.agent_type) ??
    asTrimmedString(input?.agentType) ??
    null;
  const resultText =
    extractContentText(result?.content) ??
    asTrimmedString(result?.message) ??
    asTrimmedString(result?.summary) ??
    null;
  const explicitMode =
    input?.run_in_background === true || asTrimmedString(result?.status) === "async_launched"
      ? "background"
      : resultText
        ? "foreground"
        : "unknown";
  const outputFilePath =
    asTrimmedString(result?.outputFile) ?? asTrimmedString(result?.output_file) ?? null;

  return {
    description,
    prompt,
    agentType,
    resultText,
    mode: explicitMode,
    outputFilePath,
  } as const;
}

async function readTextPreview(path: string): Promise<{
  text: string | null;
  truncated: boolean;
}> {
  const file = await openFile(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_CLAUDE_OUTPUT_PREVIEW_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) {
      return { text: null, truncated: false };
    }

    const truncated = bytesRead > MAX_CLAUDE_OUTPUT_PREVIEW_BYTES;
    const text = buffer.toString(
      "utf8",
      0,
      truncated ? MAX_CLAUDE_OUTPUT_PREVIEW_BYTES : bytesRead,
    );
    return {
      text,
      truncated,
    };
  } finally {
    await file.close();
  }
}

function extractCodexReceiverThreadIds(activity: OrchestrationThreadActivity): string[] {
  const data = activityData(activity);
  const item = asObject(data?.item) ?? data;
  const result = asObject(data?.result);
  return [
    ...asStringArray(item?.receiverThreadIds),
    ...asStringArray(data?.receiverThreadIds),
    ...asStringArray(result?.receiverThreadIds),
  ].filter((value, index, array) => array.indexOf(value) === index);
}

function normalizeCodexRole(item: unknown): "user" | "assistant" | "system" {
  const record = asObject(item);
  const type = asTrimmedString(record?.type)?.toLowerCase() ?? "";
  if (type.includes("user")) return "user";
  if (type.includes("agent") || type.includes("assistant")) return "assistant";
  return "system";
}

function extractCodexItemText(item: unknown): string | null {
  const record = asObject(item);
  const direct =
    asTrimmedString(record?.text) ??
    asTrimmedString(record?.summary) ??
    asTrimmedString(record?.prompt) ??
    asTrimmedString(record?.command) ??
    null;
  if (direct) {
    return direct;
  }

  const content = Array.isArray(record?.content) ? record.content : [];
  const parts = content
    .map((entry) => {
      const block = asObject(entry);
      return (
        asTrimmedString(block?.text) ??
        asTrimmedString(block?.delta) ??
        asTrimmedString(block?.content)
      );
    })
    .filter((value): value is string => value !== null);
  if (parts.length > 0) {
    return parts.join("\n\n");
  }

  const result = asObject(record?.result);
  const resultText =
    asTrimmedString(result?.content) ??
    asTrimmedString(result?.stdout) ??
    asTrimmedString(result?.stderr) ??
    null;
  if (resultText) {
    return resultText;
  }

  try {
    return JSON.stringify(item, null, 2);
  } catch {
    return null;
  }
}

function normalizeCodexTranscript(input: {
  providerThreadId: string;
  turns: ReadonlyArray<{
    id: TurnId;
    items: ReadonlyArray<unknown>;
  }>;
}): OrchestrationSubagentTranscriptEntry[] {
  return input.turns.flatMap((turn, turnIndex) =>
    turn.items.flatMap((item, itemIndex) => {
      const text = extractCodexItemText(item);
      if (!text) {
        return [];
      }

      return [
        {
          id: `${input.providerThreadId}:${turnIndex}:${itemIndex}`,
          role: normalizeCodexRole(item),
          text,
          turnId: turn.id,
          createdAt: null,
        },
      ] satisfies OrchestrationSubagentTranscriptEntry[];
    }),
  );
}

function resolveProjectRoot(
  thread: OrchestrationThread,
  readModel: {
    readonly projects: ReadonlyArray<{ id: string; workspaceRoot: string }>;
  },
): string {
  return (
    readModel.projects.find((project) => project.id === thread.projectId)?.workspaceRoot ??
    process.cwd()
  );
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const serverSettingsService = yield* ServerSettingsService;

  const getSubagentDetail: SubagentDetailQueryShape["getSubagentDetail"] = Effect.fn(
    "getSubagentDetail",
  )(function* (input) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === input.threadId);
    if (!thread) {
      return yield* Effect.fail(new Error(`Unknown thread '${input.threadId}'.`));
    }

    const provider = (thread.session?.providerName ??
      thread.modelSelection.provider) as ProviderKind;
    const activities = collectSubagentActivities(thread.activities, input.rootItemId);
    const rootActivity = pickRootActivity(activities, input.rootItemId);
    if (!rootActivity) {
      return yield* Effect.fail(new Error(`Unknown subagent root '${input.rootItemId}'.`));
    }

    const metadata = extractSubagentMetadata(rootActivity);
    const title = metadata.description ?? metadata.agentType ?? "Delegated agent";

    let providerThreadIds: string[] = [];
    let transcript: OrchestrationSubagentTranscriptEntry[] = [];
    let outputFilePath = metadata.outputFilePath;
    let outputText: string | null = null;
    let outputTextTruncated = false;

    if (provider === "codex") {
      providerThreadIds = extractCodexReceiverThreadIds(rootActivity);
      const providerThreadId = providerThreadIds[0];
      if (providerThreadId) {
        const settings = yield* serverSettingsService.getSettings;
        const projectRoot = resolveProjectRoot(thread, readModel);
        const snapshot = yield* Effect.tryPromise(() =>
          readCodexStoredThread({
            binaryPath: resolvePreferredCodexBinaryPath(settings.providers.codex.binaryPath),
            ...(settings.providers.codex.homePath
              ? { homePath: settings.providers.codex.homePath }
              : {}),
            cwd: projectRoot,
            providerThreadId,
          }),
        );
        transcript = normalizeCodexTranscript({
          providerThreadId,
          turns: snapshot.turns,
        });
      }
    }

    if (provider === "claudeAgent") {
      const taskCompletion = activities
        .toReversed()
        .find(
          (activity) =>
            activity.kind === "task.completed" &&
            (activityParentItemId(activity) === input.rootItemId ||
              activityItemId(activity) === input.rootItemId),
        );
      const taskCompletionPayload = taskCompletion ? activityPayload(taskCompletion) : null;
      outputFilePath =
        asTrimmedString(taskCompletionPayload?.outputFile) ??
        asTrimmedString(taskCompletionPayload?.output_file) ??
        outputFilePath;

      const nextOutputFilePath = outputFilePath;
      if (nextOutputFilePath && path.isAbsolute(nextOutputFilePath)) {
        const preview = yield* Effect.tryPromise(() => readTextPreview(nextOutputFilePath)).pipe(
          Effect.catch(() => Effect.succeed({ text: null, truncated: false })),
        );
        outputText = preview.text;
        outputTextTruncated = preview.truncated;
      }
    }

    const resolvedMode =
      metadata.mode === "unknown" && outputFilePath ? "background" : metadata.mode;
    const hasContents =
      transcript.length > 0 ||
      providerThreadIds.length > 0 ||
      activities.length > 1 ||
      metadata.resultText !== null ||
      outputFilePath !== null ||
      outputText !== null;

    return {
      provider,
      rootItemId: input.rootItemId,
      title,
      hasContents,
      description: metadata.description,
      prompt: metadata.prompt,
      agentType: metadata.agentType,
      mode: resolvedMode,
      providerThreadIds,
      resultText: metadata.resultText,
      outputFilePath,
      outputText,
      outputTextTruncated,
      activities,
      transcript,
    };
  });

  return {
    getSubagentDetail,
  } satisfies SubagentDetailQueryShape;
});

export const SubagentDetailQueryLive = Layer.effect(SubagentDetailQuery, make);
