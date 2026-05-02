import { EventId, type OrchestrationThreadActivity, ProjectId, ThreadId, TurnId } from "contracts";
import { describe, expect, it } from "vitest";

import { deriveLocalProviderUsageSummaries } from "./usageMetrics";
import type { Thread } from "../types";

function makeActivity(input: {
  id: string;
  createdAt: string;
  turnId: string | null;
  kind?: string;
  payload: unknown;
}): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(input.id),
    tone: "info",
    kind: input.kind ?? "context-window.updated",
    summary: "Context window updated",
    payload: input.payload,
    turnId: input.turnId ? TurnId.makeUnsafe(input.turnId) : null,
    createdAt: input.createdAt,
  };
}

function makeThread(input: {
  id: string;
  provider: Thread["modelSelection"]["provider"];
  activities: ReadonlyArray<OrchestrationThreadActivity>;
}): Thread {
  return {
    id: input.id as ThreadId,
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: input.id,
    modelSelection: {
      provider: input.provider,
      model: "test-model",
    } as Thread["modelSelection"],
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    resumeState: "resumed",
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-04-04T00:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-04-04T00:00:00.000Z",
    latestTurn: null,
    parentThreadId: null,
    branchSourceTurnId: null,
    branch: null,
    worktreePath: null,
    tag: null,
    turnDiffSummaries: [],
    activities: [...input.activities],
  };
}

describe("deriveLocalProviderUsageSummaries", () => {
  it("aggregates recent codex and claude turn usage from local runtime activity", () => {
    const now = Date.parse("2026-04-04T12:00:00.000Z");
    const threads = [
      makeThread({
        id: "thread-codex",
        provider: "codex",
        activities: [
          makeActivity({
            id: "codex-turn-1",
            createdAt: "2026-04-04T10:00:00.000Z",
            turnId: "turn-codex-1",
            payload: {
              lastInputTokens: 100,
              lastCachedInputTokens: 20,
              lastOutputTokens: 30,
            },
          }),
          makeActivity({
            id: "codex-turn-1-older",
            createdAt: "2026-04-04T09:55:00.000Z",
            turnId: "turn-codex-1",
            payload: {
              lastInputTokens: 5,
              lastOutputTokens: 5,
            },
          }),
          makeActivity({
            id: "codex-turn-2",
            createdAt: "2026-04-01T10:00:00.000Z",
            turnId: "turn-codex-2",
            payload: {
              inputTokens: 200,
              outputTokens: 50,
            },
          }),
        ],
      }),
      makeThread({
        id: "thread-claude",
        provider: "claudeAgent",
        activities: [
          makeActivity({
            id: "claude-turn-1",
            createdAt: "2026-04-04T08:30:00.000Z",
            turnId: "turn-claude-1",
            payload: {
              inputTokens: 300,
              outputTokens: 40,
            },
          }),
          makeActivity({
            id: "claude-non-usage",
            createdAt: "2026-04-04T08:45:00.000Z",
            turnId: "turn-claude-ignored",
            kind: "tool.updated",
            payload: {
              inputTokens: 999,
            },
          }),
        ],
      }),
      makeThread({
        id: "thread-kimi",
        provider: "kimiCode",
        activities: [
          makeActivity({
            id: "kimi-turn-1",
            createdAt: "2026-04-04T11:30:00.000Z",
            turnId: "turn-kimi-1",
            payload: {
              lastUsedTokens: 75,
            },
          }),
        ],
      }),
    ];

    const summaries = deriveLocalProviderUsageSummaries(threads, now);
    expect(summaries).toEqual([
      {
        provider: "codex",
        last5Hours: { turns: 1, approxTokens: 150 },
        last7Days: { turns: 2, approxTokens: 400 },
      },
      {
        provider: "claudeAgent",
        last5Hours: { turns: 1, approxTokens: 340 },
        last7Days: { turns: 1, approxTokens: 340 },
      },
      {
        provider: "shiori",
        last5Hours: { turns: 0, approxTokens: 0 },
        last7Days: { turns: 0, approxTokens: 0 },
      },
      {
        provider: "kimiCode",
        last5Hours: { turns: 1, approxTokens: 75 },
        last7Days: { turns: 1, approxTokens: 75 },
      },
      {
        provider: "gemini",
        last5Hours: { turns: 0, approxTokens: 0 },
        last7Days: { turns: 0, approxTokens: 0 },
      },
      {
        provider: "cursor",
        last5Hours: { turns: 0, approxTokens: 0 },
        last7Days: { turns: 0, approxTokens: 0 },
      },
    ]);
  });

  it("falls back to snapshot totals when incremental token fields are unavailable", () => {
    const now = Date.parse("2026-04-04T12:00:00.000Z");
    const summaries = deriveLocalProviderUsageSummaries(
      [
        makeThread({
          id: "thread-fallback",
          provider: "codex",
          activities: [
            makeActivity({
              id: "fallback-turn",
              createdAt: "2026-04-04T11:00:00.000Z",
              turnId: "turn-fallback",
              payload: {
                totalProcessedTokens: 512,
              },
            }),
          ],
        }),
      ],
      now,
    );

    expect(summaries[0]).toEqual({
      provider: "codex",
      last5Hours: { turns: 1, approxTokens: 512 },
      last7Days: { turns: 1, approxTokens: 512 },
    });
  });
});
