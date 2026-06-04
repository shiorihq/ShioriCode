import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ProviderRuntimeEvent } from "./providerRuntime";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

describe("ProviderRuntimeEvent", () => {
  it("decodes turn.plan.updated for plan rendering", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.plan.updated",
      eventId: "event-1",
      provider: "claudeAgent",
      sessionId: "runtime-session-1",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        explanation: "Implement schema updates",
        plan: [
          { step: "Define event union", status: "completed" },
          { step: "Wire adapter mapping", status: "inProgress" },
        ],
      },
    });

    expect(parsed.type).toBe("turn.plan.updated");
    if (parsed.type !== "turn.plan.updated") {
      throw new Error("expected turn.plan.updated");
    }
    expect(parsed.payload.plan).toHaveLength(2);
    expect(parsed.payload.plan[1]?.status).toBe("inProgress");
  });

  it("decodes turn.tasks.updated for task list rendering", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.tasks.updated",
      eventId: "event-tasks-1",
      provider: "kimiCode",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        source: "SetTodoList",
        items: [
          { id: "todo-1", title: "Inspect Kimi stream", status: "completed" },
          { id: "todo-2", title: "Wire composer tasks", status: "inProgress" },
        ],
      },
    });

    expect(parsed.type).toBe("turn.tasks.updated");
    if (parsed.type !== "turn.tasks.updated") {
      throw new Error("expected turn.tasks.updated");
    }
    expect(parsed.payload.source).toBe("SetTodoList");
    expect(parsed.payload.items[1]?.status).toBe("inProgress");
  });

  it("decodes proposed-plan completion events", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: "event-proposed-plan-1",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        planMarkdown: "# Ship it",
      },
    });

    expect(parsed.type).toBe("turn.proposed.completed");
    if (parsed.type !== "turn.proposed.completed") {
      throw new Error("expected turn.proposed.completed");
    }
    expect(parsed.payload.planMarkdown).toBe("# Ship it");
  });

  it("decodes command output deltas with stream metadata", () => {
    const parsed = decodeRuntimeEvent({
      type: "content.delta",
      eventId: "event-command-output-1",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "process-1",
      payload: {
        streamKind: "command_output",
        outputStream: "stderr",
        delta: "warning\n",
        capReached: true,
      },
    });

    expect(parsed.type).toBe("content.delta");
    if (parsed.type !== "content.delta") {
      throw new Error("expected content.delta");
    }
    expect(parsed.payload.outputStream).toBe("stderr");
    expect(parsed.payload.capReached).toBe(true);
  });

  it("decodes user-input.requested with structured questions", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.requested",
      eventId: "event-2",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow edits in workspace only",
              },
              {
                label: "danger-full-access",
                description: "Allow unrestricted access",
              },
            ],
          },
        ],
      },
    });

    expect(parsed.type).toBe("user-input.requested");
    if (parsed.type !== "user-input.requested") {
      throw new Error("expected user-input.requested");
    }
    expect(parsed.payload.questions[0]?.id).toBe("sandbox_mode");
    expect(parsed.payload.questions[0]?.options).toHaveLength(2);
  });

  it("decodes user-input.resolved with answer map", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.resolved",
      eventId: "event-3",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:02.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    expect(parsed.type).toBe("user-input.resolved");
    if (parsed.type !== "user-input.resolved") {
      throw new Error("expected user-input.resolved");
    }
    expect(parsed.payload.answers.sandbox_mode).toBe("workspace-write");
  });

  it("decodes attestation request lifecycle events", () => {
    const parsed = decodeRuntimeEvent({
      type: "request.opened",
      eventId: "event-attestation-1",
      provider: "codex",
      sessionId: "runtime-session-attestation",
      createdAt: "2026-02-28T00:00:03.000Z",
      threadId: "thread-attestation",
      requestId: "request-attestation-1",
      payload: {
        requestType: "attestation_generate",
        args: {},
      },
    });

    expect(parsed.type).toBe("request.opened");
    if (parsed.type !== "request.opened") {
      throw new Error("expected request.opened");
    }
    expect(parsed.payload.requestType).toBe("attestation_generate");
  });

  it("rejects legacy message.delta type", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "message.delta",
        eventId: "event-4",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        payload: { delta: "legacy" },
      }),
    ).toThrow();
  });

  it("rejects empty branded canonical ids", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "runtime.error",
        eventId: "event-5",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        threadId: "   ",
        payload: { message: "boom" },
      }),
    ).toThrow();
  });

  it("decodes normalized thread token usage snapshots", () => {
    const parsed = decodeRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: "event-token-usage-1",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:04.000Z",
      threadId: "thread-1",
      payload: {
        usage: {
          usedTokens: 31251,
          maxTokens: 200000,
          toolUses: 25,
          durationMs: 43567,
        },
      },
    });

    expect(parsed.type).toBe("thread.token-usage.updated");
    if (parsed.type !== "thread.token-usage.updated") {
      throw new Error("expected thread.token-usage.updated");
    }
    expect(parsed.payload.usage.maxTokens).toBe(200000);
    expect(parsed.payload.usage.usedTokens).toBe(31251);
  });

  it("decodes thread goal update and clear events", () => {
    const updated = decodeRuntimeEvent({
      type: "thread.goal.updated",
      eventId: "event-thread-goal-updated",
      provider: "codex",
      createdAt: "2026-06-04T09:00:00.000Z",
      threadId: "thread-1",
      payload: {
        goal: {
          threadId: "thread-1",
          objective: "Improve Codex compatibility",
          status: "active",
          tokenBudget: 200000,
          tokensUsed: 12000,
          timeUsedSeconds: 90,
          createdAt: "2026-04-15T17:00:00.000Z",
          updatedAt: "2026-04-15T17:01:00.000Z",
        },
      },
    });

    expect(updated.type).toBe("thread.goal.updated");
    if (updated.type !== "thread.goal.updated") {
      throw new Error("expected thread.goal.updated");
    }
    expect(updated.payload.goal.tokensUsed).toBe(12000);

    const cleared = decodeRuntimeEvent({
      type: "thread.goal.cleared",
      eventId: "event-thread-goal-cleared",
      provider: "codex",
      createdAt: "2026-06-04T09:02:00.000Z",
      threadId: "thread-1",
      payload: {
        clearedAt: "2026-06-04T09:02:00.000Z",
      },
    });

    expect(cleared.type).toBe("thread.goal.cleared");
    if (cleared.type !== "thread.goal.cleared") {
      throw new Error("expected thread.goal.cleared");
    }
    expect(cleared.payload.clearedAt).toBe("2026-06-04T09:02:00.000Z");
  });

  it("decodes structured turn completion errors", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.completed",
      eventId: "event-turn-completed-failed",
      provider: "codex",
      createdAt: "2026-06-04T09:02:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        state: "failed",
        errorMessage: "Responses stream disconnected.",
        error: {
          message: "Responses stream disconnected.",
          codexErrorInfo: {
            type: "ResponseStreamDisconnected",
            httpStatusCode: 502,
          },
          additionalDetails: {
            retryable: true,
          },
        },
      },
    });

    expect(parsed.type).toBe("turn.completed");
    if (parsed.type !== "turn.completed") {
      throw new Error("expected turn.completed");
    }
    expect(parsed.payload.errorMessage).toBe("Responses stream disconnected.");
    expect(parsed.payload.error).toEqual({
      message: "Responses stream disconnected.",
      codexErrorInfo: {
        type: "ResponseStreamDisconnected",
        httpStatusCode: 502,
      },
      additionalDetails: {
        retryable: true,
      },
    });
  });

  it("decodes realtime SDP answer events", () => {
    const parsed = decodeRuntimeEvent({
      type: "thread.realtime.sdp",
      eventId: "event-realtime-sdp",
      provider: "codex",
      createdAt: "2026-06-04T09:03:00.000Z",
      threadId: "thread-1",
      payload: {
        sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n",
      },
    });

    expect(parsed.type).toBe("thread.realtime.sdp");
    if (parsed.type !== "thread.realtime.sdp") {
      throw new Error("expected thread.realtime.sdp");
    }
    expect(parsed.payload.sdp).toContain("v=0");
  });

  it("decodes filesystem change notifications", () => {
    const parsed = decodeRuntimeEvent({
      type: "files.changed",
      eventId: "event-files-changed",
      provider: "codex",
      createdAt: "2026-06-04T09:04:00.000Z",
      threadId: "thread-1",
      payload: {
        watchId: "watch-1",
        changedPaths: ["/Users/me/project/.git/HEAD", "/Users/me/project/package.json"],
      },
    });

    expect(parsed.type).toBe("files.changed");
    if (parsed.type !== "files.changed") {
      throw new Error("expected files.changed");
    }
    expect(parsed.payload.changedPaths).toHaveLength(2);
  });

  it("decodes skills and app list update notifications", () => {
    const skillsChanged = decodeRuntimeEvent({
      type: "skills.changed",
      eventId: "event-skills-changed",
      provider: "codex",
      createdAt: "2026-06-04T09:05:00.000Z",
      threadId: "thread-1",
      payload: {
        detail: {},
      },
    });

    expect(skillsChanged.type).toBe("skills.changed");
    if (skillsChanged.type !== "skills.changed") {
      throw new Error("expected skills.changed");
    }
    expect(skillsChanged.payload.detail).toEqual({});

    const appsUpdated = decodeRuntimeEvent({
      type: "apps.list.updated",
      eventId: "event-app-list-updated",
      provider: "codex",
      createdAt: "2026-06-04T09:06:00.000Z",
      threadId: "thread-1",
      payload: {
        apps: [
          {
            id: "demo-app",
            name: "Demo App",
          },
        ],
        detail: {
          data: [
            {
              id: "demo-app",
              name: "Demo App",
            },
          ],
        },
      },
    });

    expect(appsUpdated.type).toBe("apps.list.updated");
    if (appsUpdated.type !== "apps.list.updated") {
      throw new Error("expected apps.list.updated");
    }
    expect(appsUpdated.payload.apps).toHaveLength(1);
  });

  it("decodes remote-control and external-agent import notifications", () => {
    const remoteStatus = decodeRuntimeEvent({
      type: "remote-control.status.changed",
      eventId: "event-remote-control-status",
      provider: "codex",
      createdAt: "2026-06-04T09:07:00.000Z",
      threadId: "thread-1",
      payload: {
        status: "disabled",
        serverName: "Choki MacBook",
        environmentId: null,
        detail: {
          status: "disabled",
          serverName: "Choki MacBook",
          environmentId: null,
        },
      },
    });

    expect(remoteStatus.type).toBe("remote-control.status.changed");
    if (remoteStatus.type !== "remote-control.status.changed") {
      throw new Error("expected remote-control.status.changed");
    }
    expect(remoteStatus.payload.environmentId).toBeNull();

    const importCompleted = decodeRuntimeEvent({
      type: "external-agent-config.import.completed",
      eventId: "event-external-agent-import-completed",
      provider: "codex",
      createdAt: "2026-06-04T09:08:00.000Z",
      threadId: "thread-1",
      payload: {
        detail: {
          imported: [
            {
              cwd: null,
              kind: "session",
              count: 1,
            },
          ],
        },
      },
    });

    expect(importCompleted.type).toBe("external-agent-config.import.completed");
    if (importCompleted.type !== "external-agent-config.import.completed") {
      throw new Error("expected external-agent-config.import.completed");
    }
    expect(importCompleted.payload.detail).toEqual({
      imported: [
        {
          cwd: null,
          kind: "session",
          count: 1,
        },
      ],
    });
  });

  it("decodes raw response item notifications", () => {
    const parsed = decodeRuntimeEvent({
      type: "raw-response.item",
      eventId: "event-raw-response-item",
      provider: "codex",
      createdAt: "2026-06-04T09:09:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "raw_item_1",
      payload: {
        method: "rawResponseItem/added",
        item: {
          id: "raw_item_1",
          type: "reasoning",
          summary: [],
        },
        detail: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "raw_item_1",
            type: "reasoning",
            summary: [],
          },
        },
      },
    });

    expect(parsed.type).toBe("raw-response.item");
    if (parsed.type !== "raw-response.item") {
      throw new Error("expected raw-response.item");
    }
    expect(parsed.payload.method).toBe("rawResponseItem/added");
    expect(parsed.itemId).toBe("raw_item_1");
  });
});
