import { MessageId, ProjectId, ThreadId, TurnId } from "contracts";
import { describe, expect, it } from "vitest";
import {
  buildSidebarThreadSummary,
  projectReadModelToClientSnapshot,
  selectLatestActiveThread,
} from "./orchestrationClientProjection";
import type { Thread } from "./orchestrationClientTypes";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    projectlessCwd: null,
    title: "Thread One",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    resumeState: "resumed",
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-04-17T10:00:00.000Z",
    archivedAt: null,
    pinnedAt: null,
    updatedAt: "2026-04-17T10:00:00.000Z",
    latestTurn: null,
    parentThreadId: null,
    branchSourceTurnId: null,
    branch: null,
    worktreePath: null,
    tag: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

describe("projectReadModelToClientSnapshot", () => {
  it("maps attachments and thread state into client-safe thread models", () => {
    const snapshot = projectReadModelToClientSnapshot(
      {
        snapshotSequence: 1,
        updatedAt: "2026-04-17T10:00:00.000Z",
        projects: [
          {
            id: ProjectId.makeUnsafe("project-1"),
            title: "Project One",
            workspaceRoot: "/tmp/project-one",
            defaultModelSelection: {
              provider: "codex",
              model: "gpt-5.4",
            },
            scripts: [],
            createdAt: "2026-04-17T10:00:00.000Z",
            updatedAt: "2026-04-17T10:00:00.000Z",
            deletedAt: null,
          },
        ],
        threads: [
          {
            id: ThreadId.makeUnsafe("thread-1"),
            projectId: ProjectId.makeUnsafe("project-1"),
            title: "Thread One",
            modelSelection: {
              provider: "codex",
              model: "5.4",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            parentThreadId: null,
            branchSourceTurnId: null,
            branch: null,
            worktreePath: null,
            tag: null,
            createdAt: "2026-04-17T10:00:00.000Z",
            updatedAt: "2026-04-17T10:00:00.000Z",
            archivedAt: null,
            latestTurn: null,
            messages: [
              {
                id: MessageId.makeUnsafe("message-1"),
                role: "assistant",
                text: "Done",
                attachments: [
                  {
                    type: "image",
                    id: "attachment-1",
                    name: "screenshot.png",
                    mimeType: "image/png",
                    sizeBytes: 42,
                  },
                ],
                turnId: null,
                streaming: false,
                createdAt: "2026-04-17T10:00:00.000Z",
                updatedAt: "2026-04-17T10:00:01.000Z",
              },
            ],
            proposedPlans: [],
            activities: [],
            checkpoints: [],
            session: null,
            deletedAt: null,
            resumeState: "resumed",
          },
        ],
      },
      {
        resolveAttachmentPreviewUrl: (attachmentId) => `/attachments/${attachmentId}`,
      },
    );

    expect(snapshot.projects[0]?.name).toBe("Project One");
    expect(snapshot.threads[0]?.modelSelection.model).toBe("gpt-5.4");
    expect(snapshot.threads[0]?.messages[0]?.attachments?.[0]?.previewUrl).toBe(
      "/attachments/attachment-1",
    );
  });

  it("collapses duplicate active workspace roots onto the newest project id", () => {
    const snapshot = projectReadModelToClientSnapshot({
      snapshotSequence: 2,
      updatedAt: "2026-04-17T10:10:00.000Z",
      projects: [
        {
          id: ProjectId.makeUnsafe("project-old"),
          title: "Project Old",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5.4",
          },
          scripts: [],
          createdAt: "2026-04-17T10:00:00.000Z",
          updatedAt: "2026-04-17T10:00:00.000Z",
          deletedAt: null,
        },
        {
          id: ProjectId.makeUnsafe("project-new"),
          title: "Project New",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5.4",
          },
          scripts: [],
          createdAt: "2026-04-17T10:05:00.000Z",
          updatedAt: "2026-04-17T10:05:00.000Z",
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: ThreadId.makeUnsafe("thread-old"),
          projectId: ProjectId.makeUnsafe("project-old"),
          title: "Thread Old",
          modelSelection: {
            provider: "codex",
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          parentThreadId: null,
          branchSourceTurnId: null,
          branch: null,
          worktreePath: null,
          tag: null,
          createdAt: "2026-04-17T10:01:00.000Z",
          updatedAt: "2026-04-17T10:01:00.000Z",
          archivedAt: null,
          latestTurn: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
          deletedAt: null,
          resumeState: "resumed",
        },
      ],
    });

    expect(snapshot.projects.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-new"),
    ]);
    expect(snapshot.threads[0]?.projectId).toBe(ProjectId.makeUnsafe("project-new"));
    expect(snapshot.threadIdsByProjectId[ProjectId.makeUnsafe("project-old")]).toBeUndefined();
    expect(snapshot.threadIdsByProjectId[ProjectId.makeUnsafe("project-new")]).toEqual([
      ThreadId.makeUnsafe("thread-old"),
    ]);
  });
});

describe("buildSidebarThreadSummary", () => {
  it("surfaces pending approvals and actionable plans for running threads", () => {
    const summary = buildSidebarThreadSummary(
      makeThread({
        session: {
          provider: "codex",
          status: "running",
          createdAt: "2026-04-17T10:00:00.000Z",
          updatedAt: "2026-04-17T10:00:00.000Z",
          orchestrationStatus: "running",
        },
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-04-17T10:00:00.000Z",
          startedAt: "2026-04-17T10:00:00.000Z",
          completedAt: "2026-04-17T10:00:10.000Z",
          assistantMessageId: MessageId.makeUnsafe("message-1"),
        },
        proposedPlans: [
          {
            id: "plan-1",
            turnId: TurnId.makeUnsafe("turn-1"),
            planMarkdown: "A plan",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-04-17T10:00:00.000Z",
            updatedAt: "2026-04-17T10:00:00.000Z",
          },
        ],
        activities: [
          {
            id: "activity-1",
            kind: "approval.requested",
            tone: "approval",
            summary: "Approval requested",
            payload: {
              requestId: "request-1",
              requestKind: "command",
            },
            turnId: "turn-1",
            createdAt: "2026-04-17T10:00:00.000Z",
          } as Thread["activities"][number],
        ],
      }),
    );

    expect(summary.hasPendingApprovals).toBe(true);
    expect(summary.hasActionableProposedPlan).toBe(true);
  });
});

describe("selectLatestActiveThread", () => {
  it("prefers the most recently updated unarchived thread", () => {
    const newest = makeThread({
      id: ThreadId.makeUnsafe("thread-2"),
      updatedAt: "2026-04-17T11:00:00.000Z",
    });
    const archived = makeThread({
      id: ThreadId.makeUnsafe("thread-3"),
      updatedAt: "2026-04-17T12:00:00.000Z",
      archivedAt: "2026-04-17T12:00:00.000Z",
    });

    expect(selectLatestActiveThread([makeThread(), newest, archived])?.id).toBe("thread-2");
  });
});
