import { describe, expect, it } from "vitest";

import {
  buildCursorAskQuestionResponse,
  buildCursorCreatePlanResponse,
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

  it("returns Cursor's documented accepted outcome for create_plan", () => {
    expect(buildCursorCreatePlanResponse()).toEqual({
      outcome: { outcome: "accepted" },
    });
  });
});
