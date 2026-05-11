import { GOAL_ITEMS_READ_MODEL_KEY } from "contracts";
import type {
  GoalItem,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationProject,
  OrchestrationProposedPlan,
  OrchestrationReadModel,
  OrchestrationSession,
  OrchestrationSessionStatus,
  OrchestrationThread,
  ProjectId,
  ProviderKind,
  ThreadId,
} from "contracts";
import { resolveModelSlugForProvider } from "./model";
import { normalizeProjectTitle } from "./String";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  findLatestProposedPlan,
  hasActionableProposedPlan,
} from "./orchestrationSession";
import type {
  ChatMessage,
  Project,
  SidebarThreadSummary,
  Thread,
  ThreadSession,
} from "./orchestrationClientTypes";

const MAX_THREAD_ACTIVITIES = 500;
const ACTIVITY_TRIM_PRIORITY_BY_KIND = new Map<Thread["activities"][number]["kind"], number>([
  ["reasoning.delta", 0],
  ["context-window.updated", 1],
  ["reasoning.started", 2],
  ["reasoning.completed", 2],
]);
const EMPTY_THREAD_IDS: ThreadId[] = [];

export interface ClientProjectionOptions {
  readonly resolveAttachmentPreviewUrl?: (attachmentId: string) => string | undefined;
}

export interface ClientProjectionSnapshot {
  readonly projects: Project[];
  readonly goalItems?: GoalItem[];
  readonly threads: Thread[];
  readonly threadIndexById: Record<string, number>;
  readonly sidebarThreadsById: Record<string, SidebarThreadSummary>;
  readonly threadIdsByProjectId: Record<string, ThreadId[]>;
}

function normalizeModelSelection<T extends { provider: ProviderKind; model: string }>(
  selection: T,
): T {
  return {
    ...selection,
    model: resolveModelSlugForProvider(selection.provider, selection.model),
  };
}

function mapProjectScripts(scripts: ReadonlyArray<Project["scripts"][number]>): Project["scripts"] {
  return scripts.map((script) => ({ ...script }));
}

function compareProjectCanonicalPriority(
  left: OrchestrationProject,
  right: OrchestrationProject,
): number {
  return (
    left.updatedAt.localeCompare(right.updatedAt) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function canonicalizeActiveProjects(projects: ReadonlyArray<OrchestrationProject>): {
  readonly canonicalProjects: OrchestrationProject[];
  readonly canonicalProjectIdByProjectId: ReadonlyMap<ProjectId, ProjectId>;
} {
  const activeProjects = projects.filter((project) => project.deletedAt === null);
  const canonicalProjectByWorkspaceRoot = new Map<string, OrchestrationProject>();

  for (const project of activeProjects) {
    const existing = canonicalProjectByWorkspaceRoot.get(project.workspaceRoot);
    if (!existing || compareProjectCanonicalPriority(existing, project) < 0) {
      canonicalProjectByWorkspaceRoot.set(project.workspaceRoot, project);
    }
  }

  const canonicalProjectIdByProjectId = new Map<ProjectId, ProjectId>();
  for (const project of activeProjects) {
    canonicalProjectIdByProjectId.set(
      project.id,
      canonicalProjectByWorkspaceRoot.get(project.workspaceRoot)?.id ?? project.id,
    );
  }

  return {
    canonicalProjects: activeProjects.filter(
      (project) => canonicalProjectIdByProjectId.get(project.id) === project.id,
    ),
    canonicalProjectIdByProjectId,
  };
}

function toLegacySessionStatus(
  status: OrchestrationSessionStatus,
): "connecting" | "ready" | "running" | "error" | "closed" {
  switch (status) {
    case "starting":
      return "connecting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
    case "interrupted":
      return "ready";
    case "idle":
    case "stopped":
      return "closed";
  }
}

function toLegacyProvider(providerName: string | null): ProviderKind {
  if (
    providerName === "shiori" ||
    providerName === "kimiCode" ||
    providerName === "gemini" ||
    providerName === "cursor" ||
    providerName === "codex" ||
    providerName === "claudeAgent"
  ) {
    return providerName;
  }
  return "codex";
}

export function mapSessionToThreadSession(session: OrchestrationSession): ThreadSession {
  return {
    provider: toLegacyProvider(session.providerName),
    status: toLegacySessionStatus(session.status),
    orchestrationStatus: session.status,
    activeTurnId: session.activeTurnId ?? undefined,
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
    ...(session.lastError ? { lastError: session.lastError } : {}),
  };
}

export function visibleSessionError(
  session: OrchestrationSession | null | undefined,
): string | null {
  return session?.status === "error" ? (session.lastError ?? null) : null;
}

export function mapMessageToChatMessage(
  message: OrchestrationMessage,
  options: ClientProjectionOptions = {},
): ChatMessage {
  const attachments = message.attachments
    ?.map((attachment) => {
      const previewUrl = options.resolveAttachmentPreviewUrl?.(attachment.id);
      return {
        type: "image" as const,
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        ...(previewUrl ? { previewUrl } : {}),
      };
    })
    .filter((attachment) => attachment !== null);

  return {
    id: message.id,
    role: message.role,
    text: message.text,
    turnId: message.turnId,
    createdAt: message.createdAt,
    streaming: message.streaming,
    ...(message.streaming ? {} : { completedAt: message.updatedAt }),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}

export function mapProposedPlanToClientProposedPlan(
  proposedPlan: OrchestrationProposedPlan,
): Thread["proposedPlans"][number] {
  return {
    id: proposedPlan.id,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
  };
}

export function mapCheckpointToTurnDiffSummary(
  checkpoint: OrchestrationCheckpointSummary,
): Thread["turnDiffSummaries"][number] {
  return {
    turnId: checkpoint.turnId,
    completedAt: checkpoint.completedAt,
    status: checkpoint.status,
    assistantMessageId: checkpoint.assistantMessageId ?? undefined,
    checkpointTurnCount: checkpoint.checkpointTurnCount,
    checkpointRef: checkpoint.checkpointRef,
    files: checkpoint.files.map((file) => ({ ...file })),
  };
}

function asActivityRecord(
  value: Thread["activities"][number]["payload"],
): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function reasoningDeltaCompactionKey(activity: Thread["activities"][number]): string | null {
  if (activity.kind !== "reasoning.delta") {
    return null;
  }

  const payload = asActivityRecord(activity.payload);
  const itemId = asTrimmedString(payload?.itemId);
  const taskId = asTrimmedString(payload?.taskId);
  const summaryIndex = asInteger(payload?.summaryIndex);
  const logicalId = itemId ?? taskId;
  if (!logicalId) {
    return null;
  }

  return [activity.turnId ?? "", logicalId, summaryIndex === null ? "" : String(summaryIndex)].join(
    "\u001f",
  );
}

function mergeReasoningDeltaActivities(
  previous: Thread["activities"][number],
  next: Thread["activities"][number],
): Thread["activities"][number] {
  const previousPayload = asActivityRecord(previous.payload) ?? {};
  const nextPayload = asActivityRecord(next.payload) ?? {};
  const previousDelta = asString(previousPayload.delta) ?? "";
  const nextDelta = asString(nextPayload.delta) ?? "";

  return {
    ...previous,
    payload: {
      ...previousPayload,
      ...nextPayload,
      delta: `${previousDelta}${nextDelta}`,
    },
    ...(previous.sequence !== undefined ? { sequence: previous.sequence } : {}),
  };
}

function trimCompactedActivities(
  activities: ReadonlyArray<Thread["activities"][number]>,
): Thread["activities"] {
  if (activities.length <= MAX_THREAD_ACTIVITIES) {
    return [...activities];
  }

  const retained = [...activities];
  let overflow = retained.length - MAX_THREAD_ACTIVITIES;

  for (const priority of [0, 1, 2]) {
    for (let index = 0; index < retained.length && overflow > 0; ) {
      const activity = retained[index];
      if (activity && ACTIVITY_TRIM_PRIORITY_BY_KIND.get(activity.kind) === priority) {
        retained.splice(index, 1);
        overflow -= 1;
        continue;
      }
      index += 1;
    }
    if (overflow <= 0) {
      return retained;
    }
  }

  return retained.slice(-MAX_THREAD_ACTIVITIES);
}

export function compactThreadActivities(
  activities: ReadonlyArray<Thread["activities"][number]>,
): Thread["activities"] {
  if (activities.length === 0) {
    return [];
  }

  const compacted: Thread["activities"] = [];
  for (const activity of activities) {
    const previous = compacted.at(-1);
    if (!previous) {
      compacted.push({ ...activity });
      continue;
    }

    const previousKey = reasoningDeltaCompactionKey(previous);
    const nextKey = reasoningDeltaCompactionKey(activity);
    if (previousKey !== null && previousKey === nextKey) {
      compacted[compacted.length - 1] = mergeReasoningDeltaActivities(previous, activity);
      continue;
    }

    compacted.push({ ...activity });
  }

  return trimCompactedActivities(compacted);
}

export function mapThreadToClientThread(
  thread: OrchestrationThread,
  options: ClientProjectionOptions = {},
): Thread {
  return {
    id: thread.id,
    codexThreadId: null,
    projectId: thread.projectId,
    projectlessCwd: thread.projectlessCwd ?? null,
    title: thread.title,
    modelSelection: normalizeModelSelection(thread.modelSelection),
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    session: thread.session ? mapSessionToThreadSession(thread.session) : null,
    resumeState: thread.resumeState ?? "resumed",
    messages: thread.messages.map((message) => mapMessageToChatMessage(message, options)),
    proposedPlans: thread.proposedPlans.map(mapProposedPlanToClientProposedPlan),
    error: visibleSessionError(thread.session),
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt ?? null,
    updatedAt: thread.updatedAt,
    latestTurn: thread.latestTurn,
    pendingSourceProposedPlan: thread.latestTurn?.sourceProposedPlan,
    parentThreadId: thread.parentThreadId ?? null,
    branchSourceTurnId: thread.branchSourceTurnId ?? null,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    tag: thread.tag ?? null,
    turnDiffSummaries: thread.checkpoints.map(mapCheckpointToTurnDiffSummary),
    activities: compactThreadActivities(thread.activities),
  };
}

export function mapProjectToClientProject(
  project: OrchestrationReadModel["projects"][number],
): Project {
  return {
    id: project.id,
    name: normalizeProjectTitle(project.title),
    cwd: project.workspaceRoot,
    defaultModelSelection: project.defaultModelSelection
      ? normalizeModelSelection(project.defaultModelSelection)
      : null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    scripts: mapProjectScripts(project.scripts),
  };
}

function getLatestUserMessageAt(
  messages: ReadonlyArray<Thread["messages"][number]>,
): string | null {
  let latestUserMessageAt: string | null = null;

  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    if (latestUserMessageAt === null || message.createdAt > latestUserMessageAt) {
      latestUserMessageAt = message.createdAt;
    }
  }

  return latestUserMessageAt;
}

export function buildSidebarThreadSummary(thread: Thread): SidebarThreadSummary {
  return {
    id: thread.id,
    projectId: thread.projectId,
    projectlessCwd: thread.projectlessCwd ?? null,
    title: thread.title,
    modelProvider: thread.modelSelection.provider,
    interactionMode: thread.interactionMode,
    session: thread.session,
    resumeState: thread.resumeState ?? "resumed",
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt ?? null,
    updatedAt: thread.updatedAt,
    latestTurn: thread.latestTurn,
    parentThreadId: thread.parentThreadId ?? null,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    tag: thread.tag,
    latestUserMessageAt: getLatestUserMessageAt(thread.messages),
    hasPendingApprovals:
      thread.session?.orchestrationStatus === "running" &&
      derivePendingApprovals(thread.activities).length > 0,
    hasPendingUserInput:
      thread.session?.orchestrationStatus === "running" &&
      derivePendingUserInputs(thread.activities).length > 0,
    hasActionableProposedPlan: hasActionableProposedPlan(
      findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId ?? null),
    ),
  };
}

export function buildThreadIdsByProjectId(
  threads: ReadonlyArray<Thread>,
): Record<string, ThreadId[]> {
  const threadIdsByProjectId: Record<string, ThreadId[]> = {};
  for (const thread of threads) {
    if (thread.projectId === null) {
      continue;
    }
    const existingThreadIds = threadIdsByProjectId[thread.projectId] ?? EMPTY_THREAD_IDS;
    threadIdsByProjectId[thread.projectId] = [...existingThreadIds, thread.id];
  }
  return threadIdsByProjectId;
}

export function buildThreadIndexById(threads: ReadonlyArray<Thread>): Record<string, number> {
  const threadIndexById: Record<string, number> = {};
  for (const [index, thread] of threads.entries()) {
    threadIndexById[thread.id] = index;
  }
  return threadIndexById;
}

export function buildSidebarThreadsById(
  threads: ReadonlyArray<Thread>,
): Record<string, SidebarThreadSummary> {
  return Object.fromEntries(
    threads.map((thread) => [thread.id, buildSidebarThreadSummary(thread)]),
  );
}

export function projectReadModelToClientSnapshot(
  readModel: OrchestrationReadModel,
  options: ClientProjectionOptions = {},
): ClientProjectionSnapshot {
  const { canonicalProjects, canonicalProjectIdByProjectId } = canonicalizeActiveProjects(
    readModel.projects,
  );
  const projects = canonicalProjects.map(mapProjectToClientProject);
  const goalItems = (readModel[GOAL_ITEMS_READ_MODEL_KEY] ?? [])
    .filter((item) => item.deletedAt === null)
    .map((item) => {
      const canonicalProjectId =
        canonicalProjectIdByProjectId.get(item.projectId) ?? item.projectId;
      return canonicalProjectId === item.projectId
        ? item
        : Object.assign({}, item, { projectId: canonicalProjectId });
    });
  const threads = readModel.threads
    .filter((thread) => thread.deletedAt === null)
    .map((thread) => {
      if (thread.projectId === null) {
        return mapThreadToClientThread(thread, options);
      }
      const canonicalProjectId =
        canonicalProjectIdByProjectId.get(thread.projectId) ?? thread.projectId;
      return canonicalProjectId === thread.projectId
        ? mapThreadToClientThread(thread, options)
        : mapThreadToClientThread({ ...thread, projectId: canonicalProjectId }, options);
    });

  return {
    projects,
    goalItems,
    threads,
    threadIndexById: buildThreadIndexById(threads),
    sidebarThreadsById: buildSidebarThreadsById(threads),
    threadIdsByProjectId: buildThreadIdsByProjectId(threads),
  };
}

export function listActiveThreadsByUpdatedAt(
  threads: ReadonlyArray<Thread>,
  projectId?: ProjectId,
): Thread[] {
  return threads
    .filter((thread) => thread.archivedAt === null)
    .filter((thread) => (projectId ? thread.projectId === projectId : true))
    .toSorted((left, right) => {
      const leftUpdatedAt = left.updatedAt ?? left.createdAt;
      const rightUpdatedAt = right.updatedAt ?? right.createdAt;
      return (
        rightUpdatedAt.localeCompare(leftUpdatedAt) ||
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id)
      );
    });
}

export function selectLatestActiveThread(
  threads: ReadonlyArray<Thread>,
  projectId?: ProjectId,
): Thread | null {
  return listActiveThreadsByUpdatedAt(threads, projectId)[0] ?? null;
}
