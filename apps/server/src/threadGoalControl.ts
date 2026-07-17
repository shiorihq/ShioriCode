import { CommandId, type ThreadGoal, type ThreadId } from "contracts";
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import type { OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine.ts";
import { verifyThreadGoalCapability } from "./threadGoalCapability.ts";

export const THREAD_GOAL_CONTROL_PATH = "/api/internal/thread-goal";

interface ThreadGoalControlResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bearerToken(authorization: string | undefined): string | null {
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  return match?.[1] ?? null;
}

function goalId(goal: ThreadGoal): string {
  return goal.lifecycleId ?? goal.createdAt;
}

function serializeGoal(goal: ThreadGoal): Record<string, unknown> {
  return {
    goal_id: goalId(goal),
    objective: goal.objective,
    status: goal.status,
    token_budget: goal.tokenBudget,
    tokens_used: goal.tokensUsed,
    time_used_seconds: goal.timeUsedSeconds,
    created_at: goal.createdAt,
    updated_at: goal.updatedAt,
  };
}

function response(status: number, body: Record<string, unknown>): ThreadGoalControlResponse {
  return { status, body };
}

/** Handles the capability-authenticated control request without trusting a body thread id. */
export async function handleThreadGoalControlRequest(input: {
  readonly authorization?: string | undefined;
  readonly body: unknown;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly verifyCapability?: ((token: string) => ThreadId | null) | undefined;
  readonly now?: (() => string) | undefined;
}): Promise<ThreadGoalControlResponse> {
  const token = bearerToken(input.authorization);
  const threadId = token ? (input.verifyCapability ?? verifyThreadGoalCapability)(token) : null;
  if (!threadId) {
    return response(401, { ok: false, error: "Invalid thread-goal capability." });
  }
  if (!isRecord(input.body)) {
    return response(400, { ok: false, error: "Invalid thread-goal request body." });
  }

  const readModel = await Effect.runPromise(input.orchestrationEngine.getReadModel());
  const thread = readModel.threads.find(
    (entry) => entry.id === threadId && entry.deletedAt === null && entry.archivedAt === null,
  );
  if (!thread) {
    return response(404, { ok: false, error: "Thread not found." });
  }

  const currentGoalId = thread.goal ? goalId(thread.goal) : null;
  const activeTurnId =
    thread.session?.status === "running" ? (thread.session.activeTurnId ?? null) : null;
  const activeTurnOwnsCurrentGoal =
    activeTurnId !== null &&
    currentGoalId !== null &&
    thread.session?.goalLifecycleKey === currentGoalId;
  const acceptedTurnOwnsCurrentGoal =
    activeTurnId === null &&
    currentGoalId !== null &&
    (thread.session?.status === "ready" || thread.session?.status === "running") &&
    thread.session.goalLifecycleKey === currentGoalId;
  const providerInvocationOwnsCurrentGoal =
    activeTurnOwnsCurrentGoal || acceptedTurnOwnsCurrentGoal;

  if (input.body.action === "get") {
    return response(200, {
      ok: true,
      goal: thread.goal && providerInvocationOwnsCurrentGoal ? serializeGoal(thread.goal) : null,
    });
  }

  if (input.body.action !== "update") {
    return response(400, { ok: false, error: "Unknown thread-goal action." });
  }

  const requestedGoalId = typeof input.body.goal_id === "string" ? input.body.goal_id.trim() : "";
  const status = input.body.status;
  if (!requestedGoalId) {
    return response(400, { ok: false, error: "goal_id is required." });
  }
  if (status !== "complete" && status !== "blocked") {
    return response(400, {
      ok: false,
      error: "status must be either 'complete' or 'blocked'.",
    });
  }
  if (!thread.goal) {
    return response(404, { ok: false, error: "This thread has no goal." });
  }
  if (requestedGoalId !== currentGoalId) {
    return response(409, { ok: false, error: "The goal lifecycle is stale." });
  }
  if (!providerInvocationOwnsCurrentGoal) {
    return response(409, {
      ok: false,
      error: "The accepted provider turn is not bound to this goal lifecycle.",
    });
  }

  const createdAt = input.now?.() ?? new Date().toISOString();
  try {
    await Effect.runPromise(
      input.orchestrationEngine.dispatch({
        type: "thread.goal.status.report",
        commandId: CommandId.makeUnsafe(`server:thread-goal-status:${crypto.randomUUID()}`),
        threadId,
        expectedGoalLifecycleKey: currentGoalId,
        status,
        ...(activeTurnId ? { turnId: activeTurnId } : {}),
        createdAt,
      }),
    );
  } catch {
    // The decider performs the final lifecycle compare-and-set. A concurrent
    // replacement is reported as a conflict rather than changing the new goal.
    return response(409, { ok: false, error: "The goal lifecycle changed concurrently." });
  }

  return response(200, {
    ok: true,
    goal: {
      ...serializeGoal(thread.goal),
      status,
      updated_at: createdAt > thread.goal.updatedAt ? createdAt : thread.goal.updatedAt,
    },
  });
}

function jsonResponse(body: unknown, status: number) {
  return HttpServerResponse.text(`${JSON.stringify(body)}\n`, {
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
  });
}

export const threadGoalControlRouteLayer = HttpRouter.add(
  "POST",
  THREAD_GOAL_CONTROL_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const result = yield* Effect.promise(() =>
      handleThreadGoalControlRequest({
        authorization: request.headers.authorization,
        body,
        orchestrationEngine,
      }),
    );
    return jsonResponse(result.body, result.status);
  }),
);
