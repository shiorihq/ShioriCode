import { CommandId, MessageId, ThreadId } from "contracts";
import { describe, expect, it } from "vitest";

import {
  summarizeClientCommand,
  summarizeSettingsPatch,
  withTelemetrySource,
} from "./RpcTelemetry.ts";

describe("RpcTelemetry", () => {
  it("summarizes thread turn start commands without leaking raw prompt contents", () => {
    expect(
      summarizeClientCommand({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("command-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: MessageId.makeUnsafe("message-1"),
          role: "user",
          text: "ship analytics please",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "plan",
        createdAt: "2026-04-08T00:00:00.000Z",
      }),
    ).toEqual({
      commandType: "thread.turn.start",
      runtimeMode: "full-access",
      interactionMode: "plan",
      promptLength: "ship analytics please".length,
      attachmentCount: 0,
      hasTitleSeed: false,
      fromProposedPlan: false,
    });
  });

  it("summarizes settings patches by changed keys", () => {
    expect(
      summarizeSettingsPatch({
        onboarding: {
          completedStepIds: ["sign-in"],
        },
      }),
    ).toEqual({
      patchKeys: ["onboarding"],
      patchKeyCount: 1,
    });
  });

  it("adds a telemetry source to client properties", () => {
    expect(
      withTelemetrySource("web-client", {
        path: "/settings/general",
      }),
    ).toEqual({
      source: "web-client",
      path: "/settings/general",
    });
  });
});
