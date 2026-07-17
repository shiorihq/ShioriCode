import { describe, expect, it, vi } from "vitest";

import { runThreadGoalTool, THREAD_GOAL_TOOL_SCHEMAS } from "./threadGoalMcpServer.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("thread-goal MCP server", () => {
  it("exposes only the provider-neutral get and update tools", () => {
    expect(THREAD_GOAL_TOOL_SCHEMAS.map((tool) => tool.name)).toEqual(["get_goal", "update_goal"]);
    expect(THREAD_GOAL_TOOL_SCHEMAS[1].inputSchema).toMatchObject({
      required: ["goal_id", "status"],
      properties: { status: { enum: ["complete", "blocked"] } },
    });
  });

  it("gets the current goal through the scoped control route", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ ok: true, goal: { goal_id: "goal-a", status: "active" } }),
    );
    const result = await runThreadGoalTool(
      "get_goal",
      {},
      {
        controlUrl: "http://127.0.0.1:4321/api/internal/thread-goal",
        capabilityToken: "capability",
        fetch,
      },
    );

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4321/api/internal/thread-goal",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer capability" }),
        body: JSON.stringify({ action: "get" }),
      }),
    );
    expect(result.content[0]?.text).toContain('"goal_id": "goal-a"');
  });

  it("requires the lifecycle id and forwards only terminal provider reports", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      jsonResponse({
        ok: true,
        goal: {
          goal_id: "goal-a",
          status: JSON.parse(String(init?.body)).status as unknown,
        },
      }),
    );
    const options = {
      controlUrl: "http://127.0.0.1:4321/api/internal/thread-goal",
      capabilityToken: "capability",
      fetch,
    };

    await runThreadGoalTool("update_goal", { goal_id: "goal-a", status: "complete" }, options);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      action: "update",
      goal_id: "goal-a",
      status: "complete",
    });
    await expect(
      runThreadGoalTool("update_goal", { goal_id: "goal-a", status: "active" }, options),
    ).rejects.toThrow(/complete.*blocked/);
    await expect(runThreadGoalTool("update_goal", { status: "blocked" }, options)).rejects.toThrow(
      /goal_id is required/,
    );
  });

  it("surfaces control-route rejections", async () => {
    await expect(
      runThreadGoalTool(
        "get_goal",
        {},
        {
          controlUrl: "http://127.0.0.1:4321/api/internal/thread-goal",
          capabilityToken: "bad",
          fetch: async () =>
            jsonResponse({ ok: false, error: "Invalid thread-goal capability." }, 401),
        },
      ),
    ).rejects.toThrow("Invalid thread-goal capability");
  });
});
