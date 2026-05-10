import { describe, expect, it } from "vitest";

import {
  applyCursorTodosUpdate,
  buildCursorAskQuestionResponse,
  buildCursorCreatePlanResponse,
  makeCursorTodoPlanState,
} from "./CursorAcpExtension.ts";

describe("Cursor ACP extension helpers", () => {
  it("maps Shiori user-input answer labels back to Cursor option ids", () => {
    expect(
      buildCursorAskQuestionResponse(
        {
          toolCallId: "tool-1",
          questions: [
            {
              id: "mode",
              prompt: "Which mode should I use?",
              options: [
                { id: "agent", label: "Agent" },
                { id: "plan", label: "Plan" },
              ],
            },
          ],
        },
        { mode: "Plan" },
      ),
    ).toEqual({
      outcome: {
        outcome: "answered",
        answers: [{ questionId: "mode", selectedOptionIds: ["plan"] }],
      },
    });
  });

  it("returns Cursor's cancelled outcome when pending user input is interrupted", () => {
    expect(
      buildCursorAskQuestionResponse(
        {
          toolCallId: "tool-1",
          questions: [
            {
              id: "mode",
              prompt: "Which mode should I use?",
              options: [{ id: "agent", label: "Agent" }],
            },
          ],
        },
        {},
      ),
    ).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  it("answers empty-option questions with an empty selected list", () => {
    expect(
      buildCursorAskQuestionResponse(
        {
          toolCallId: "tool-1",
          questions: [
            {
              id: "continue",
              prompt: "Continue?",
              options: [],
            },
          ],
        },
        {},
      ),
    ).toEqual({
      outcome: {
        outcome: "answered",
        answers: [{ questionId: "continue", selectedOptionIds: [] }],
      },
    });
  });

  it("returns Cursor's documented accepted outcome for create_plan", () => {
    expect(buildCursorCreatePlanResponse()).toEqual({
      outcome: { outcome: "accepted" },
    });
  });

  it("preserves existing todos and patches fields when merge is true", () => {
    const state = makeCursorTodoPlanState();

    applyCursorTodosUpdate(state, {
      toolCallId: "todos-1",
      merge: false,
      todos: [
        { id: "a", content: "Inspect Cursor provider", status: "in_progress" },
        { id: "b", content: "Write tests", status: "pending" },
      ],
    });
    const plan = applyCursorTodosUpdate(state, {
      toolCallId: "todos-2",
      merge: true,
      todos: [{ id: "a", status: "completed" }],
    });

    expect(plan).toEqual({
      plan: [
        { step: "Inspect Cursor provider", status: "completed" },
        { step: "Write tests", status: "pending" },
      ],
    });
  });

  it("replaces todo state when merge is false", () => {
    const state = makeCursorTodoPlanState();

    applyCursorTodosUpdate(state, {
      toolCallId: "todos-1",
      merge: false,
      todos: [
        { id: "a", content: "Old task", status: "pending" },
        { id: "b", content: "Another old task", status: "pending" },
      ],
    });
    const plan = applyCursorTodosUpdate(state, {
      toolCallId: "todos-2",
      merge: false,
      todos: [{ id: "c", content: "New task", status: "in_progress" }],
    });

    expect(plan).toEqual({
      plan: [{ step: "New task", status: "inProgress" }],
    });
  });
});
