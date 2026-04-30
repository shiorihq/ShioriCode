import {
  type OrchestrationEvent,
  type KanbanItem,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type ProjectId,
  type ProviderKind,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationCheckpointSummary,
  type OrchestrationThread,
} from "contracts";
import {
  buildSidebarThreadSummary as buildSidebarThreadSummaryShared,
  compactThreadActivities as compactThreadActivitiesShared,
  mapCheckpointToTurnDiffSummary as mapCheckpointToTurnDiffSummaryShared,
  mapMessageToChatMessage as mapMessageToChatMessageShared,
  mapProjectToClientProject as mapProjectToClientProjectShared,
  mapProposedPlanToClientProposedPlan as mapProposedPlanToClientProposedPlanShared,
  projectReadModelToClientSnapshot,
  mapSessionToThreadSession as mapSessionToThreadSessionShared,
} from "shared/orchestrationClientProjection";
import { resolveModelSlugForProvider } from "shared/model";
import { normalizeProjectTitle } from "shared/String";
import { create } from "zustand";
import {
  derivePhase,
  findLatestProposedPlan,
  hasActionableProposedPlan,
  derivePendingApprovals,
  derivePendingUserInputs,
} from "./session-logic";
import {
  hasServerAcknowledgedLocalDispatch,
  type LocalDispatchSnapshot,
} from "./threadDispatchState";
import { type ChatMessage, type Project, type SidebarThreadSummary, type Thread } from "./types";

// ── State ────────────────────────────────────────────────────────────

export interface AppState {
  projects: Project[];
  kanbanItems?: KanbanItem[];
  threads: Thread[];
  threadIndexById: Record<string, number>;
  sidebarThreadsById: Record<string, SidebarThreadSummary>;
  threadIdsByProjectId: Record<string, ThreadId[]>;
  pendingThreadDispatchById: Record<string, LocalDispatchSnapshot | undefined>;
  bootstrapComplete: boolean;
}

const initialState: AppState = {
  projects: [],
  kanbanItems: [],
  threads: [],
  threadIndexById: {},
  sidebarThreadsById: {},
  threadIdsByProjectId: {},
  pendingThreadDispatchById: {},
  bootstrapComplete: false,
};
const MAX_THREAD_MESSAGES = 2_000;
const MAX_THREAD_CHECKPOINTS = 500;
const MAX_THREAD_PROPOSED_PLANS = 200;
const EMPTY_THREAD_IDS: ThreadId[] = [];

// ── Pure helpers ──────────────────────────────────────────────────────

function updateProject(
  projects: Project[],
  projectId: Project["id"],
  updater: (project: Project) => Project,
): Project[] {
  let changed = false;
  const next = projects.map((project) => {
    if (project.id !== projectId) {
      return project;
    }
    const updated = updater(project);
    if (updated !== project) {
      changed = true;
    }
    return updated;
  });
  return changed ? next : projects;
}

function updateKanbanItem(
  kanbanItems: KanbanItem[],
  itemId: KanbanItem["id"],
  updater: (item: KanbanItem) => KanbanItem,
): KanbanItem[] {
  let changed = false;
  const next = kanbanItems.map((item) => {
    if (item.id !== itemId) {
      return item;
    }
    const updated = updater(item);
    if (updated !== item) {
      changed = true;
    }
    return updated;
  });
  return changed ? next : kanbanItems;
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

function mapSession(session: OrchestrationSession): Thread["session"] {
  return mapSessionToThreadSessionShared(session);
}

function mapMessage(message: OrchestrationMessage): ChatMessage {
  return mapMessageToChatMessageShared(message, {
    resolveAttachmentPreviewUrl: (attachmentId) =>
      toAttachmentPreviewUrl(attachmentPreviewRoutePath(attachmentId)),
  });
}

function mapProposedPlan(proposedPlan: OrchestrationProposedPlan): Thread["proposedPlans"][number] {
  return mapProposedPlanToClientProposedPlanShared(proposedPlan);
}

function mapTurnDiffSummary(
  checkpoint: OrchestrationCheckpointSummary,
): Thread["turnDiffSummaries"][number] {
  return mapCheckpointToTurnDiffSummaryShared(checkpoint);
}

function compactThreadActivities(
  activities: ReadonlyArray<Thread["activities"][number]>,
): Thread["activities"] {
  return compactThreadActivitiesShared(activities);
}

function mapThread(thread: OrchestrationThread): Thread {
  return {
    id: thread.id,
    codexThreadId: null,
    projectId: thread.projectId,
    projectlessCwd: thread.projectlessCwd ?? null,
    title: thread.title,
    modelSelection: normalizeModelSelection(thread.modelSelection),
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    session: thread.session ? mapSession(thread.session) : null,
    resumeState: thread.resumeState ?? "resumed",
    messages: thread.messages.map(mapMessage),
    proposedPlans: thread.proposedPlans.map(mapProposedPlan),
    error: thread.session?.lastError ?? null,
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
    turnDiffSummaries: thread.checkpoints.map(mapTurnDiffSummary),
    activities: compactThreadActivities(thread.activities),
  };
}

function mapProject(project: OrchestrationReadModel["projects"][number]): Project {
  return mapProjectToClientProjectShared(project);
}

function buildSidebarThreadSummary(thread: Thread): SidebarThreadSummary {
  return buildSidebarThreadSummaryShared(thread);
}

function sidebarThreadSummariesEqual(
  left: SidebarThreadSummary | undefined,
  right: SidebarThreadSummary,
): boolean {
  return (
    left !== undefined &&
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.projectlessCwd === right.projectlessCwd &&
    left.title === right.title &&
    left.interactionMode === right.interactionMode &&
    left.session === right.session &&
    left.resumeState === right.resumeState &&
    left.createdAt === right.createdAt &&
    left.archivedAt === right.archivedAt &&
    left.pinnedAt === right.pinnedAt &&
    left.updatedAt === right.updatedAt &&
    left.latestTurn === right.latestTurn &&
    left.parentThreadId === right.parentThreadId &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    left.tag === right.tag &&
    left.latestUserMessageAt === right.latestUserMessageAt &&
    left.hasPendingApprovals === right.hasPendingApprovals &&
    left.hasPendingUserInput === right.hasPendingUserInput &&
    left.hasActionableProposedPlan === right.hasActionableProposedPlan
  );
}

function appendThreadIdByProjectId(
  threadIdsByProjectId: Record<string, ThreadId[]>,
  projectId: ProjectId | null,
  threadId: ThreadId,
): Record<string, ThreadId[]> {
  if (projectId === null) {
    return threadIdsByProjectId;
  }
  const existingThreadIds = threadIdsByProjectId[projectId] ?? EMPTY_THREAD_IDS;
  if (existingThreadIds.includes(threadId)) {
    return threadIdsByProjectId;
  }
  return {
    ...threadIdsByProjectId,
    [projectId]: [...existingThreadIds, threadId],
  };
}

function removeThreadIdByProjectId(
  threadIdsByProjectId: Record<string, ThreadId[]>,
  projectId: ProjectId | null,
  threadId: ThreadId,
): Record<string, ThreadId[]> {
  if (projectId === null) {
    return threadIdsByProjectId;
  }
  const existingThreadIds = threadIdsByProjectId[projectId] ?? EMPTY_THREAD_IDS;
  if (!existingThreadIds.includes(threadId)) {
    return threadIdsByProjectId;
  }
  const nextThreadIds = existingThreadIds.filter(
    (existingThreadId) => existingThreadId !== threadId,
  );
  if (nextThreadIds.length === existingThreadIds.length) {
    return threadIdsByProjectId;
  }
  if (nextThreadIds.length === 0) {
    const nextThreadIdsByProjectId = { ...threadIdsByProjectId };
    delete nextThreadIdsByProjectId[projectId];
    return nextThreadIdsByProjectId;
  }
  return {
    ...threadIdsByProjectId,
    [projectId]: nextThreadIds,
  };
}

function buildThreadIdsByProjectId(threads: ReadonlyArray<Thread>): Record<string, ThreadId[]> {
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

function buildThreadIndexById(threads: ReadonlyArray<Thread>): Record<string, number> {
  const threadIndexById: Record<string, number> = {};
  for (const [index, thread] of threads.entries()) {
    threadIndexById[thread.id] = index;
  }
  return threadIndexById;
}

function buildSidebarThreadsById(
  threads: ReadonlyArray<Thread>,
): Record<string, SidebarThreadSummary> {
  return Object.fromEntries(
    threads.map((thread) => [thread.id, buildSidebarThreadSummary(thread)]),
  );
}

function clearPendingThreadDispatchRecord(
  pendingThreadDispatchById: AppState["pendingThreadDispatchById"],
  threadId: ThreadId,
): AppState["pendingThreadDispatchById"] {
  if (!(threadId in pendingThreadDispatchById)) {
    return pendingThreadDispatchById;
  }
  const nextPendingThreadDispatchById = { ...pendingThreadDispatchById };
  delete nextPendingThreadDispatchById[threadId];
  return nextPendingThreadDispatchById;
}

function hasPendingThreadDispatchBeenAcknowledged(
  thread: Thread,
  pendingThreadDispatch: LocalDispatchSnapshot | null | undefined,
): boolean {
  if (!pendingThreadDispatch) {
    return false;
  }
  const threadSessionStatus = thread.session?.orchestrationStatus ?? null;
  return hasServerAcknowledgedLocalDispatch({
    localDispatch: pendingThreadDispatch,
    phase: derivePhase(thread.session ?? null),
    latestTurn: thread.latestTurn,
    activities: thread.activities,
    hasPendingApproval:
      threadSessionStatus === "running" && derivePendingApprovals(thread.activities).length > 0,
    hasPendingUserInput:
      threadSessionStatus === "running" && derivePendingUserInputs(thread.activities).length > 0,
    threadError: thread.error,
  });
}

function preserveExistingThreadRuntimeState(existing: Thread, nextThread: Thread): Thread {
  const existingUpdatedAt = existing.updatedAt ?? existing.createdAt;
  const nextUpdatedAt = nextThread.updatedAt ?? nextThread.createdAt;

  return {
    ...nextThread,
    session: existing.session,
    resumeState: existing.resumeState,
    messages: existing.messages,
    proposedPlans: existing.proposedPlans,
    error: existing.error,
    archivedAt: existing.archivedAt,
    updatedAt: existingUpdatedAt > nextUpdatedAt ? existingUpdatedAt : nextUpdatedAt,
    latestTurn: existing.latestTurn,
    pendingSourceProposedPlan: existing.pendingSourceProposedPlan,
    turnDiffSummaries: existing.turnDiffSummaries,
    activities: existing.activities,
  };
}

function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") {
    return "error" as const;
  }
  if (status === "missing") {
    return "interrupted" as const;
  }
  return "completed" as const;
}

function compareActivities(
  left: Thread["activities"][number],
  right: Thread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function buildLatestTurn(params: {
  previous: Thread["latestTurn"];
  turnId: NonNullable<Thread["latestTurn"]>["turnId"];
  state: NonNullable<Thread["latestTurn"]>["state"];
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"];
  sourceProposedPlan?: Thread["pendingSourceProposedPlan"];
}): NonNullable<Thread["latestTurn"]> {
  const resolvedPlan =
    params.previous?.turnId === params.turnId
      ? params.previous.sourceProposedPlan
      : params.sourceProposedPlan;
  return {
    turnId: params.turnId,
    state: params.state,
    requestedAt: params.requestedAt,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    assistantMessageId: params.assistantMessageId,
    ...(resolvedPlan ? { sourceProposedPlan: resolvedPlan } : {}),
  };
}

function rebindTurnDiffSummariesForAssistantMessage(
  turnDiffSummaries: ReadonlyArray<Thread["turnDiffSummaries"][number]>,
  turnId: Thread["turnDiffSummaries"][number]["turnId"],
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"],
): Thread["turnDiffSummaries"] {
  let changed = false;
  const nextSummaries = turnDiffSummaries.map((summary) => {
    if (summary.turnId !== turnId || summary.assistantMessageId === assistantMessageId) {
      return summary;
    }
    changed = true;
    return {
      ...summary,
      assistantMessageId: assistantMessageId ?? undefined,
    };
  });
  return changed ? nextSummaries : (turnDiffSummaries as Thread["turnDiffSummaries"]);
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<ChatMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ChatMessage[] {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (
      message.turnId !== undefined &&
      message.turnId !== null &&
      retainedTurnIds.has(message.turnId)
    ) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === undefined ||
            message.turnId === null ||
            retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === undefined ||
            message.turnId === null ||
            retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<Thread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): Thread["activities"] {
  return compactThreadActivities(
    activities.filter(
      (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
    ),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<Thread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): Thread["proposedPlans"] {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function resolveWsHttpOrigin(): string {
  if (typeof window === "undefined") return "";
  const bridgeWsUrl = window.desktopBridge?.getWsUrl?.();
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsCandidate =
    typeof bridgeWsUrl === "string" && bridgeWsUrl.length > 0
      ? bridgeWsUrl
      : typeof envWsUrl === "string" && envWsUrl.length > 0
        ? envWsUrl
        : null;
  if (!wsCandidate) return window.location.origin;
  try {
    const wsUrl = new URL(wsCandidate);
    const protocol =
      wsUrl.protocol === "wss:" ? "https:" : wsUrl.protocol === "ws:" ? "http:" : wsUrl.protocol;
    return `${protocol}//${wsUrl.host}`;
  } catch {
    return window.location.origin;
  }
}

function toAttachmentPreviewUrl(rawUrl: string): string {
  if (rawUrl.startsWith("/")) {
    return `${resolveWsHttpOrigin()}${rawUrl}`;
  }
  return rawUrl;
}

function attachmentPreviewRoutePath(attachmentId: string): string {
  return `/attachments/${encodeURIComponent(attachmentId)}`;
}

function updateThreadState(
  state: AppState,
  threadId: ThreadId,
  updater: (thread: Thread) => Thread,
  summaryUpdater: (
    previousSummary: SidebarThreadSummary | undefined,
    updatedThread: Thread,
  ) => SidebarThreadSummary = (_previousSummary, updatedThread) =>
    buildSidebarThreadSummary(updatedThread),
): AppState {
  const threadIndex = state.threadIndexById[threadId];
  if (threadIndex === undefined) {
    return state;
  }

  const existingThread = state.threads[threadIndex];
  if (!existingThread) {
    return state;
  }

  const updatedThread = updater(existingThread);
  if (updatedThread === existingThread) {
    return state;
  }

  const threads = [...state.threads];
  threads[threadIndex] = updatedThread;
  const pendingThreadDispatch = state.pendingThreadDispatchById[threadId];
  const nextPendingThreadDispatchById = hasPendingThreadDispatchBeenAcknowledged(
    updatedThread,
    pendingThreadDispatch,
  )
    ? clearPendingThreadDispatchRecord(state.pendingThreadDispatchById, threadId)
    : state.pendingThreadDispatchById;

  const previousSummary = state.sidebarThreadsById[threadId];
  const nextSummary = summaryUpdater(previousSummary, updatedThread);
  const sidebarThreadsById = sidebarThreadSummariesEqual(previousSummary, nextSummary)
    ? state.sidebarThreadsById
    : {
        ...state.sidebarThreadsById,
        [threadId]: nextSummary,
      };

  if (
    sidebarThreadsById === state.sidebarThreadsById &&
    nextPendingThreadDispatchById === state.pendingThreadDispatchById
  ) {
    return {
      ...state,
      threads,
    };
  }

  return {
    ...state,
    threads,
    sidebarThreadsById,
    pendingThreadDispatchById: nextPendingThreadDispatchById,
  };
}

function buildSidebarThreadSummaryForMessageEvent(
  previousSummary: SidebarThreadSummary | undefined,
  thread: Thread,
  payload: Extract<OrchestrationEvent, { type: "thread.message-sent" }>["payload"],
): SidebarThreadSummary {
  if (!previousSummary) {
    return buildSidebarThreadSummary(thread);
  }

  const latestUserMessageAt =
    payload.role === "user" &&
    (previousSummary.latestUserMessageAt === null ||
      payload.createdAt > previousSummary.latestUserMessageAt)
      ? payload.createdAt
      : previousSummary.latestUserMessageAt;

  return {
    ...previousSummary,
    updatedAt: thread.updatedAt,
    latestTurn: thread.latestTurn,
    latestUserMessageAt,
    hasActionableProposedPlan: hasActionableProposedPlan(
      findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId ?? null),
    ),
  };
}

function mergeThreadMessage(existingMessage: ChatMessage, nextMessage: ChatMessage): ChatMessage {
  const nextText = nextMessage.streaming
    ? `${existingMessage.text}${nextMessage.text}`
    : nextMessage.text.length > 0
      ? nextMessage.text
      : existingMessage.text;
  const nextCompletedAt = nextMessage.streaming
    ? existingMessage.completedAt
    : (nextMessage.completedAt ?? existingMessage.completedAt);
  const nextAttachments =
    nextMessage.attachments !== undefined ? nextMessage.attachments : existingMessage.attachments;

  if (
    nextText === existingMessage.text &&
    nextMessage.streaming === existingMessage.streaming &&
    nextMessage.turnId === existingMessage.turnId &&
    nextCompletedAt === existingMessage.completedAt &&
    nextAttachments === existingMessage.attachments
  ) {
    return existingMessage;
  }

  return {
    ...existingMessage,
    text: nextText,
    streaming: nextMessage.streaming,
    ...(nextMessage.turnId !== undefined ? { turnId: nextMessage.turnId } : {}),
    ...(nextCompletedAt !== undefined ? { completedAt: nextCompletedAt } : {}),
    ...(nextAttachments !== undefined ? { attachments: nextAttachments } : {}),
  };
}

function upsertThreadMessage(
  messages: ReadonlyArray<ChatMessage>,
  message: ChatMessage,
): ChatMessage[] {
  const lastIndex = messages.length - 1;
  const lastMessage = lastIndex >= 0 ? messages[lastIndex] : undefined;
  if (lastMessage?.id === message.id) {
    const mergedMessage = mergeThreadMessage(lastMessage, message);
    if (mergedMessage === lastMessage) {
      return messages as ChatMessage[];
    }
    const nextMessages = [...messages];
    nextMessages[lastIndex] = mergedMessage;
    return nextMessages;
  }

  const existingIndex = messages.findIndex((entry) => entry.id === message.id);
  if (existingIndex < 0) {
    return [...messages, message];
  }

  const existingMessage = messages[existingIndex];
  if (!existingMessage) {
    return [...messages, message];
  }

  const mergedMessage = mergeThreadMessage(existingMessage, message);
  if (mergedMessage === existingMessage) {
    return messages as ChatMessage[];
  }

  const nextMessages = [...messages];
  nextMessages[existingIndex] = mergedMessage;
  return nextMessages;
}

// ── Pure state transition functions ────────────────────────────────────

export function syncServerReadModel(state: AppState, readModel: OrchestrationReadModel): AppState {
  const projection = projectReadModelToClientSnapshot(readModel, {
    resolveAttachmentPreviewUrl: (attachmentId) =>
      toAttachmentPreviewUrl(attachmentPreviewRoutePath(attachmentId)),
  });
  const pendingThreadDispatchById = projection.threads.reduce<
    AppState["pendingThreadDispatchById"]
  >((nextPendingThreadDispatchById, thread) => {
    const pendingThreadDispatch = state.pendingThreadDispatchById[thread.id];
    if (
      pendingThreadDispatch &&
      hasPendingThreadDispatchBeenAcknowledged(thread, pendingThreadDispatch)
    ) {
      return clearPendingThreadDispatchRecord(nextPendingThreadDispatchById, thread.id);
    }
    return nextPendingThreadDispatchById;
  }, state.pendingThreadDispatchById);
  return {
    ...state,
    ...projection,
    pendingThreadDispatchById,
    bootstrapComplete: true,
  };
}

export function applyOrchestrationEvent(state: AppState, event: OrchestrationEvent): AppState {
  switch (event.type) {
    case "project.created": {
      const existingIndex = state.projects.findIndex(
        (project) =>
          project.id === event.payload.projectId || project.cwd === event.payload.workspaceRoot,
      );
      const replacedProject = existingIndex >= 0 ? state.projects[existingIndex] : undefined;
      const nextProject = mapProject({
        id: event.payload.projectId,
        title: event.payload.title,
        workspaceRoot: event.payload.workspaceRoot,
        defaultModelSelection: event.payload.defaultModelSelection,
        scripts: event.payload.scripts,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
        deletedAt: null,
      });
      const projects =
        existingIndex >= 0
          ? state.projects.map((project, index) =>
              index === existingIndex ? nextProject : project,
            )
          : [nextProject, ...state.projects];
      if (
        !replacedProject ||
        replacedProject.id === nextProject.id ||
        replacedProject.cwd !== nextProject.cwd
      ) {
        return { ...state, projects };
      }

      const threads = state.threads.map((thread) =>
        thread.projectId === replacedProject.id ? { ...thread, projectId: nextProject.id } : thread,
      );

      return {
        ...state,
        projects,
        threads,
        threadIndexById: buildThreadIndexById(threads),
        sidebarThreadsById: buildSidebarThreadsById(threads),
        threadIdsByProjectId: buildThreadIdsByProjectId(threads),
      };
    }

    case "project.meta-updated": {
      const projects = updateProject(state.projects, event.payload.projectId, (project) => ({
        ...project,
        ...(event.payload.title !== undefined
          ? { name: normalizeProjectTitle(event.payload.title) }
          : {}),
        ...(event.payload.workspaceRoot !== undefined ? { cwd: event.payload.workspaceRoot } : {}),
        ...(event.payload.defaultModelSelection !== undefined
          ? {
              defaultModelSelection: event.payload.defaultModelSelection
                ? normalizeModelSelection(event.payload.defaultModelSelection)
                : null,
            }
          : {}),
        ...(event.payload.scripts !== undefined
          ? { scripts: mapProjectScripts(event.payload.scripts) }
          : {}),
        updatedAt: event.payload.updatedAt,
      }));
      return projects === state.projects ? state : { ...state, projects };
    }

    case "project.deleted": {
      const projects = state.projects.filter((project) => project.id !== event.payload.projectId);
      return projects.length === state.projects.length ? state : { ...state, projects };
    }

    case "kanbanItem.created": {
      const existingItems = state.kanbanItems ?? [];
      const existing = existingItems.find((item) => item.id === event.payload.item.id);
      const kanbanItems = existing
        ? existingItems.map((item) =>
            item.id === event.payload.item.id ? event.payload.item : item,
          )
        : [...existingItems, event.payload.item];
      return { ...state, kanbanItems };
    }

    case "kanbanItem.updated": {
      const existingItems = state.kanbanItems ?? [];
      const kanbanItems = updateKanbanItem(existingItems, event.payload.itemId, (item) => ({
        ...item,
        ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
        ...(event.payload.description !== undefined
          ? { description: event.payload.description }
          : {}),
        ...(event.payload.prompt !== undefined ? { prompt: event.payload.prompt } : {}),
        ...(event.payload.generatedPrompt !== undefined
          ? { generatedPrompt: event.payload.generatedPrompt }
          : {}),
        ...(event.payload.promptStatus !== undefined
          ? { promptStatus: event.payload.promptStatus }
          : {}),
        ...(event.payload.promptError !== undefined
          ? { promptError: event.payload.promptError }
          : {}),
        ...(event.payload.pullRequest !== undefined
          ? { pullRequest: event.payload.pullRequest }
          : {}),
        updatedAt: event.payload.updatedAt,
      }));
      return kanbanItems === existingItems ? state : { ...state, kanbanItems };
    }

    case "kanbanItem.moved": {
      const existingItems = state.kanbanItems ?? [];
      const kanbanItems = updateKanbanItem(existingItems, event.payload.itemId, (item) => ({
        ...item,
        status: event.payload.status,
        sortKey: event.payload.sortKey,
        completedAt: event.payload.status === "done" ? event.payload.movedAt : null,
        updatedAt: event.payload.movedAt,
      }));
      return kanbanItems === existingItems ? state : { ...state, kanbanItems };
    }

    case "kanbanItem.assigned": {
      const existingItems = state.kanbanItems ?? [];
      const kanbanItems = updateKanbanItem(existingItems, event.payload.itemId, (item) => ({
        ...item,
        assignees: [
          ...item.assignees.filter((assignee) => assignee.id !== event.payload.assignee.id),
          event.payload.assignee,
        ],
        updatedAt: event.payload.updatedAt,
      }));
      return kanbanItems === existingItems ? state : { ...state, kanbanItems };
    }

    case "kanbanItem.unassigned": {
      const existingItems = state.kanbanItems ?? [];
      const kanbanItems = updateKanbanItem(existingItems, event.payload.itemId, (item) => ({
        ...item,
        assignees: item.assignees.filter((assignee) => assignee.id !== event.payload.assigneeId),
        updatedAt: event.payload.updatedAt,
      }));
      return kanbanItems === existingItems ? state : { ...state, kanbanItems };
    }

    case "kanbanItem.blocked": {
      const existingItems = state.kanbanItems ?? [];
      const kanbanItems = updateKanbanItem(existingItems, event.payload.itemId, (item) => ({
        ...item,
        blockedReason: event.payload.reason,
        updatedAt: event.payload.blockedAt,
      }));
      return kanbanItems === existingItems ? state : { ...state, kanbanItems };
    }

    case "kanbanItem.unblocked": {
      const existingItems = state.kanbanItems ?? [];
      const kanbanItems = updateKanbanItem(existingItems, event.payload.itemId, (item) => ({
        ...item,
        blockedReason: null,
        updatedAt: event.payload.unblockedAt,
      }));
      return kanbanItems === existingItems ? state : { ...state, kanbanItems };
    }

    case "kanbanItem.completed": {
      const existingItems = state.kanbanItems ?? [];
      const kanbanItems = updateKanbanItem(existingItems, event.payload.itemId, (item) => ({
        ...item,
        status: "done",
        ...(event.payload.sortKey !== undefined ? { sortKey: event.payload.sortKey } : {}),
        completedAt: event.payload.completedAt,
        updatedAt: event.payload.completedAt,
      }));
      return kanbanItems === existingItems ? state : { ...state, kanbanItems };
    }

    case "kanbanItem.note-added": {
      const existingItems = state.kanbanItems ?? [];
      const kanbanItems = updateKanbanItem(existingItems, event.payload.itemId, (item) => ({
        ...item,
        notes: [
          ...item.notes.filter((note) => note.id !== event.payload.note.id),
          event.payload.note,
        ].toSorted(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
        ),
        updatedAt: event.payload.updatedAt,
      }));
      return kanbanItems === existingItems ? state : { ...state, kanbanItems };
    }

    case "kanbanItem.deleted": {
      const existingItems = state.kanbanItems ?? [];
      const kanbanItems = existingItems.filter((item) => item.id !== event.payload.itemId);
      return kanbanItems.length === existingItems.length ? state : { ...state, kanbanItems };
    }

    case "thread.created": {
      const existing = state.threads.find((thread) => thread.id === event.payload.threadId);
      const createdThread = mapThread({
        id: event.payload.threadId,
        projectId: event.payload.projectId,
        projectlessCwd: event.payload.projectlessCwd ?? null,
        title: event.payload.title,
        modelSelection: event.payload.modelSelection,
        runtimeMode: event.payload.runtimeMode,
        interactionMode: event.payload.interactionMode,
        parentThreadId: event.payload.parentThreadId ?? null,
        branchSourceTurnId: event.payload.branchSourceTurnId ?? null,
        branch: event.payload.branch,
        worktreePath: event.payload.worktreePath,
        tag: event.payload.tag ?? null,
        resumeState: "resumed",
        latestTurn: null,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
        pinnedAt: event.payload.pinnedAt ?? null,
        archivedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      });
      const nextThread =
        existing === undefined
          ? createdThread
          : preserveExistingThreadRuntimeState(existing, createdThread);
      const threads = existing
        ? state.threads.map((thread) => (thread.id === nextThread.id ? nextThread : thread))
        : [...state.threads, nextThread];
      const nextSummary = buildSidebarThreadSummary(nextThread);
      const previousSummary = state.sidebarThreadsById[nextThread.id];
      const sidebarThreadsById = sidebarThreadSummariesEqual(previousSummary, nextSummary)
        ? state.sidebarThreadsById
        : {
            ...state.sidebarThreadsById,
            [nextThread.id]: nextSummary,
          };
      const nextThreadIdsByProjectId =
        existing !== undefined && existing.projectId !== nextThread.projectId
          ? removeThreadIdByProjectId(state.threadIdsByProjectId, existing.projectId, existing.id)
          : state.threadIdsByProjectId;
      const threadIdsByProjectId = appendThreadIdByProjectId(
        nextThreadIdsByProjectId,
        nextThread.projectId,
        nextThread.id,
      );
      return {
        ...state,
        threads,
        threadIndexById: buildThreadIndexById(threads),
        sidebarThreadsById,
        threadIdsByProjectId,
      };
    }

    case "thread.deleted": {
      const threads = state.threads.filter((thread) => thread.id !== event.payload.threadId);
      if (threads.length === state.threads.length) {
        return state;
      }
      const deletedThread = state.threads.find((thread) => thread.id === event.payload.threadId);
      const sidebarThreadsById = { ...state.sidebarThreadsById };
      delete sidebarThreadsById[event.payload.threadId];
      const pendingThreadDispatchById = clearPendingThreadDispatchRecord(
        state.pendingThreadDispatchById,
        event.payload.threadId,
      );
      const threadIdsByProjectId = deletedThread
        ? removeThreadIdByProjectId(
            state.threadIdsByProjectId,
            deletedThread.projectId,
            deletedThread.id,
          )
        : state.threadIdsByProjectId;
      return {
        ...state,
        threads,
        threadIndexById: buildThreadIndexById(threads),
        sidebarThreadsById,
        threadIdsByProjectId,
        pendingThreadDispatchById,
      };
    }

    case "thread.archived": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        archivedAt: event.payload.archivedAt,
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "thread.unarchived": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        archivedAt: null,
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "thread.meta-updated": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: normalizeModelSelection(event.payload.modelSelection) }
          : {}),
        ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
        ...(event.payload.worktreePath !== undefined
          ? { worktreePath: event.payload.worktreePath }
          : {}),
        ...(event.payload.tag !== undefined ? { tag: event.payload.tag } : {}),
        ...(event.payload.pinnedAt !== undefined ? { pinnedAt: event.payload.pinnedAt } : {}),
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "thread.runtime-mode-set": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        runtimeMode: event.payload.runtimeMode,
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "thread.interaction-mode-set": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        interactionMode: event.payload.interactionMode,
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "thread.turn-start-requested": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: normalizeModelSelection(event.payload.modelSelection) }
          : {}),
        runtimeMode: event.payload.runtimeMode,
        interactionMode: event.payload.interactionMode,
        pendingSourceProposedPlan: event.payload.sourceProposedPlan,
        updatedAt: event.occurredAt,
      }));
    }

    case "thread.turn-interrupt-requested": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const interruptedTurnId = event.payload.turnId ?? thread.session?.activeTurnId;
        if (interruptedTurnId === undefined) {
          return thread;
        }
        const latestTurn = thread.latestTurn;
        const shouldInterruptLatestTurn =
          latestTurn !== null && latestTurn.turnId === interruptedTurnId;
        const shouldClearRunningSession =
          thread.session?.orchestrationStatus === "running" &&
          thread.session.activeTurnId === interruptedTurnId;

        if (!shouldInterruptLatestTurn && !shouldClearRunningSession) {
          return thread;
        }

        return {
          ...thread,
          latestTurn: shouldInterruptLatestTurn
            ? buildLatestTurn({
                previous: latestTurn,
                turnId: interruptedTurnId,
                state: "interrupted",
                requestedAt: latestTurn.requestedAt,
                startedAt: latestTurn.startedAt ?? event.payload.createdAt,
                completedAt: latestTurn.completedAt ?? event.payload.createdAt,
                assistantMessageId: latestTurn.assistantMessageId,
              })
            : latestTurn,
          session:
            shouldClearRunningSession && thread.session
              ? {
                  ...thread.session,
                  status: "ready",
                  orchestrationStatus: "interrupted",
                  activeTurnId: undefined,
                  updatedAt: event.payload.createdAt,
                }
              : thread.session,
          updatedAt: event.occurredAt,
        };
      });
    }

    case "thread.message-sent": {
      return updateThreadState(
        state,
        event.payload.threadId,
        (thread) => {
          const message = mapMessage({
            id: event.payload.messageId,
            role: event.payload.role,
            text: event.payload.text,
            ...(event.payload.attachments !== undefined
              ? { attachments: event.payload.attachments }
              : {}),
            turnId: event.payload.turnId,
            streaming: event.payload.streaming,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
          });
          const messages = upsertThreadMessage(thread.messages, message);
          const cappedMessages = messages.slice(-MAX_THREAD_MESSAGES);
          const turnDiffSummaries =
            event.payload.role === "assistant" && event.payload.turnId !== null
              ? rebindTurnDiffSummariesForAssistantMessage(
                  thread.turnDiffSummaries,
                  event.payload.turnId,
                  event.payload.messageId,
                )
              : thread.turnDiffSummaries;
          const latestTurn: Thread["latestTurn"] =
            event.payload.role === "assistant" &&
            event.payload.turnId !== null &&
            (thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId)
              ? buildLatestTurn({
                  previous: thread.latestTurn,
                  turnId: event.payload.turnId,
                  state: event.payload.streaming
                    ? "running"
                    : thread.latestTurn?.state === "interrupted"
                      ? "interrupted"
                      : thread.latestTurn?.state === "error"
                        ? "error"
                        : "completed",
                  requestedAt:
                    thread.latestTurn?.turnId === event.payload.turnId
                      ? thread.latestTurn.requestedAt
                      : event.payload.createdAt,
                  startedAt:
                    thread.latestTurn?.turnId === event.payload.turnId
                      ? (thread.latestTurn.startedAt ?? event.payload.createdAt)
                      : event.payload.createdAt,
                  sourceProposedPlan: thread.pendingSourceProposedPlan,
                  completedAt: event.payload.streaming
                    ? thread.latestTurn?.turnId === event.payload.turnId
                      ? (thread.latestTurn.completedAt ?? null)
                      : null
                    : event.payload.updatedAt,
                  assistantMessageId: event.payload.messageId,
                })
              : thread.latestTurn;
          return {
            ...thread,
            messages: cappedMessages,
            turnDiffSummaries,
            latestTurn,
            updatedAt: event.occurredAt,
          };
        },
        (previousSummary, updatedThread) =>
          buildSidebarThreadSummaryForMessageEvent(previousSummary, updatedThread, event.payload),
      );
    }

    case "thread.session-set": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        session: mapSession(event.payload.session),
        error: event.payload.session.lastError ?? null,
        latestTurn:
          event.payload.session.status === "running" && event.payload.session.activeTurnId !== null
            ? buildLatestTurn({
                previous: thread.latestTurn,
                turnId: event.payload.session.activeTurnId,
                state: "running",
                requestedAt:
                  thread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? thread.latestTurn.requestedAt
                    : event.payload.session.updatedAt,
                startedAt:
                  thread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? (thread.latestTurn.startedAt ?? event.payload.session.updatedAt)
                    : event.payload.session.updatedAt,
                completedAt: null,
                assistantMessageId:
                  thread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? thread.latestTurn.assistantMessageId
                    : null,
                sourceProposedPlan: thread.pendingSourceProposedPlan,
              })
            : thread.latestTurn,
        updatedAt: event.occurredAt,
      }));
    }

    case "thread.resume-state-set": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        resumeState: event.payload.resumeState,
        updatedAt: event.occurredAt,
      }));
    }

    case "thread.session-stop-requested": {
      return updateThreadState(state, event.payload.threadId, (thread) =>
        thread.session === null
          ? thread
          : {
              ...thread,
              session: {
                ...thread.session,
                status: "closed",
                orchestrationStatus: "stopped",
                activeTurnId: undefined,
                updatedAt: event.payload.createdAt,
              },
              updatedAt: event.occurredAt,
            },
      );
    }

    case "thread.proposed-plan-upserted": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const proposedPlan = mapProposedPlan(event.payload.proposedPlan);
        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== proposedPlan.id),
          proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-MAX_THREAD_PROPOSED_PLANS);
        return {
          ...thread,
          proposedPlans,
          updatedAt: event.occurredAt,
        };
      });
    }

    case "thread.turn-diff-completed": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const checkpoint = mapTurnDiffSummary({
          turnId: event.payload.turnId,
          checkpointTurnCount: event.payload.checkpointTurnCount,
          checkpointRef: event.payload.checkpointRef,
          status: event.payload.status,
          files: event.payload.files,
          assistantMessageId: event.payload.assistantMessageId,
          completedAt: event.payload.completedAt,
        });
        const existing = thread.turnDiffSummaries.find(
          (entry) => entry.turnId === checkpoint.turnId,
        );
        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return thread;
        }
        const turnDiffSummaries = [
          ...thread.turnDiffSummaries.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted(
            (left, right) =>
              (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
              (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
          )
          .slice(-MAX_THREAD_CHECKPOINTS);
        const latestTurn =
          thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId
            ? buildLatestTurn({
                previous: thread.latestTurn,
                turnId: event.payload.turnId,
                state: checkpointStatusToLatestTurnState(event.payload.status),
                requestedAt: thread.latestTurn?.requestedAt ?? event.payload.completedAt,
                startedAt: thread.latestTurn?.startedAt ?? event.payload.completedAt,
                completedAt: event.payload.completedAt,
                assistantMessageId: event.payload.assistantMessageId,
                sourceProposedPlan: thread.pendingSourceProposedPlan,
              })
            : thread.latestTurn;
        return {
          ...thread,
          turnDiffSummaries,
          latestTurn,
          updatedAt: event.occurredAt,
        };
      });
    }

    case "thread.reverted": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const turnDiffSummaries = thread.turnDiffSummaries
          .filter(
            (entry) =>
              entry.checkpointTurnCount !== undefined &&
              entry.checkpointTurnCount <= event.payload.turnCount,
          )
          .toSorted(
            (left, right) =>
              (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
              (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
          )
          .slice(-MAX_THREAD_CHECKPOINTS);
        const retainedTurnIds = new Set(turnDiffSummaries.map((entry) => entry.turnId));
        const messages = retainThreadMessagesAfterRevert(
          thread.messages,
          retainedTurnIds,
          event.payload.turnCount,
        ).slice(-MAX_THREAD_MESSAGES);
        const proposedPlans = retainThreadProposedPlansAfterRevert(
          thread.proposedPlans,
          retainedTurnIds,
        ).slice(-MAX_THREAD_PROPOSED_PLANS);
        const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);
        const latestCheckpoint = turnDiffSummaries.at(-1) ?? null;

        return {
          ...thread,
          turnDiffSummaries,
          messages,
          proposedPlans,
          activities,
          pendingSourceProposedPlan: undefined,
          latestTurn:
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(
                    (latestCheckpoint.status ?? "ready") as "ready" | "missing" | "error",
                  ),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
                },
          updatedAt: event.occurredAt,
        };
      });
    }

    case "thread.activity-appended": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const activities = compactThreadActivities(
          [
            ...thread.activities.filter((activity) => activity.id !== event.payload.activity.id),
            { ...event.payload.activity },
          ].toSorted(compareActivities),
        );
        return {
          ...thread,
          activities,
          updatedAt: event.occurredAt,
        };
      });
    }

    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
      return state;
  }

  return state;
}

export function applyOrchestrationEvents(
  state: AppState,
  events: ReadonlyArray<OrchestrationEvent>,
): AppState {
  if (events.length === 0) {
    return state;
  }
  return events.reduce((nextState, event) => applyOrchestrationEvent(nextState, event), state);
}

export const selectProjectById =
  (projectId: Project["id"] | null | undefined) =>
  (state: AppState): Project | undefined =>
    projectId ? state.projects.find((project) => project.id === projectId) : undefined;

export const selectThreadById =
  (threadId: ThreadId | null | undefined) =>
  (state: AppState): Thread | undefined =>
    threadId !== null && threadId !== undefined
      ? state.threads[state.threadIndexById[threadId] ?? -1]
      : undefined;

export const selectSidebarThreadSummaryById =
  (threadId: ThreadId | null | undefined) =>
  (state: AppState): SidebarThreadSummary | undefined =>
    threadId ? state.sidebarThreadsById[threadId] : undefined;

export const selectThreadIdsByProjectId =
  (projectId: ProjectId | null | undefined) =>
  (state: AppState): ThreadId[] =>
    projectId ? (state.threadIdsByProjectId[projectId] ?? EMPTY_THREAD_IDS) : EMPTY_THREAD_IDS;

export function setError(state: AppState, threadId: ThreadId, error: string | null): AppState {
  return updateThreadState(state, threadId, (t) => {
    if (t.error === error) return t;
    return { ...t, error };
  });
}

export function setThreadBranch(
  state: AppState,
  threadId: ThreadId,
  branch: string | null,
  worktreePath: string | null,
): AppState {
  return updateThreadState(state, threadId, (t) => {
    if (t.branch === branch && t.worktreePath === worktreePath) return t;
    const cwdChanged = t.worktreePath !== worktreePath;
    return {
      ...t,
      branch,
      worktreePath,
      ...(cwdChanged ? { session: null } : {}),
    };
  });
}

// ── Zustand store ────────────────────────────────────────────────────

interface AppStore extends AppState {
  syncServerReadModel: (readModel: OrchestrationReadModel) => void;
  applyOrchestrationEvent: (event: OrchestrationEvent) => void;
  applyOrchestrationEvents: (events: ReadonlyArray<OrchestrationEvent>) => void;
  setError: (threadId: ThreadId, error: string | null) => void;
  setThreadBranch: (threadId: ThreadId, branch: string | null, worktreePath: string | null) => void;
  beginPendingThreadDispatch: (threadId: ThreadId, pendingDispatch: LocalDispatchSnapshot) => void;
  clearPendingThreadDispatch: (threadId: ThreadId) => void;
}

export const useStore = create<AppStore>((set) => ({
  ...initialState,
  syncServerReadModel: (readModel) => set((state) => syncServerReadModel(state, readModel)),
  applyOrchestrationEvent: (event) => set((state) => applyOrchestrationEvent(state, event)),
  applyOrchestrationEvents: (events) => set((state) => applyOrchestrationEvents(state, events)),
  setError: (threadId, error) => set((state) => setError(state, threadId, error)),
  setThreadBranch: (threadId, branch, worktreePath) =>
    set((state) => setThreadBranch(state, threadId, branch, worktreePath)),
  beginPendingThreadDispatch: (threadId, pendingDispatch) =>
    set((state) => {
      const existing = state.pendingThreadDispatchById[threadId];
      if (existing === pendingDispatch) {
        return state;
      }
      if (
        existing &&
        existing.startedAt === pendingDispatch.startedAt &&
        existing.preparingWorktree === pendingDispatch.preparingWorktree &&
        existing.latestTurnTurnId === pendingDispatch.latestTurnTurnId &&
        existing.latestTurnRequestedAt === pendingDispatch.latestTurnRequestedAt &&
        existing.latestTurnStartedAt === pendingDispatch.latestTurnStartedAt &&
        existing.latestTurnCompletedAt === pendingDispatch.latestTurnCompletedAt
      ) {
        return state;
      }
      return {
        ...state,
        pendingThreadDispatchById: {
          ...state.pendingThreadDispatchById,
          [threadId]: pendingDispatch,
        },
      };
    }),
  clearPendingThreadDispatch: (threadId) =>
    set((state) => {
      const pendingThreadDispatchById = clearPendingThreadDispatchRecord(
        state.pendingThreadDispatchById,
        threadId,
      );
      return pendingThreadDispatchById === state.pendingThreadDispatchById
        ? state
        : {
            ...state,
            pendingThreadDispatchById,
          };
    }),
}));
