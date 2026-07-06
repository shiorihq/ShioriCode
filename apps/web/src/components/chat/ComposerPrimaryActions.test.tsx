import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

describe("ComposerPrimaryActions", () => {
  it("shows a spinner button only while the send is awaiting acknowledgment", () => {
    const markup = renderToStaticMarkup(
      <ComposerPrimaryActions
        compact={false}
        pendingAction={null}
        isRunning
        awaitingSendAck
        queuedTurnCount={0}
        showPlanFollowUpPrompt={false}
        promptHasText={false}
        isSendBusy={false}
        isConnecting={false}
        isPreparingWorktree={false}
        hasSendableContent={false}
        canSteerRunningTurn={false}
        onQueueRunningTurn={() => {}}
        onPreviousPendingQuestion={() => {}}
        onInterrupt={() => {}}
        onImplementPlanInNewThread={() => {}}
      />,
    );

    expect(markup).toContain("Waiting for response");
    expect(markup).not.toContain("Stop generation");
  });

  it("returns to the stop button after the send is acknowledged", () => {
    const markup = renderToStaticMarkup(
      <ComposerPrimaryActions
        compact={false}
        pendingAction={null}
        isRunning
        awaitingSendAck={false}
        queuedTurnCount={0}
        showPlanFollowUpPrompt={false}
        promptHasText={false}
        isSendBusy={false}
        isConnecting={false}
        isPreparingWorktree={false}
        hasSendableContent={false}
        canSteerRunningTurn={false}
        onQueueRunningTurn={() => {}}
        onPreviousPendingQuestion={() => {}}
        onInterrupt={() => {}}
        onImplementPlanInNewThread={() => {}}
      />,
    );

    expect(markup).toContain("Stop generation");
    expect(markup).not.toContain("Waiting for response");
  });

  it("offers steering as the submit action and queueing as a secondary action when live steering is available", () => {
    const markup = renderToStaticMarkup(
      <ComposerPrimaryActions
        compact={false}
        pendingAction={null}
        isRunning
        awaitingSendAck={false}
        queuedTurnCount={0}
        showPlanFollowUpPrompt={false}
        promptHasText
        isSendBusy={false}
        isConnecting={false}
        isPreparingWorktree={false}
        hasSendableContent
        canSteerRunningTurn
        onQueueRunningTurn={() => {}}
        onPreviousPendingQuestion={() => {}}
        onInterrupt={() => {}}
        onImplementPlanInNewThread={() => {}}
      />,
    );

    expect(markup).toContain("Steer");
    expect(markup).toContain("Queue");
  });

  it("only offers queueing when live steering is unavailable", () => {
    const markup = renderToStaticMarkup(
      <ComposerPrimaryActions
        compact={false}
        pendingAction={null}
        isRunning
        awaitingSendAck={false}
        queuedTurnCount={0}
        showPlanFollowUpPrompt={false}
        promptHasText
        isSendBusy={false}
        isConnecting={false}
        isPreparingWorktree={false}
        hasSendableContent
        canSteerRunningTurn={false}
        onQueueRunningTurn={() => {}}
        onPreviousPendingQuestion={() => {}}
        onInterrupt={() => {}}
        onImplementPlanInNewThread={() => {}}
      />,
    );

    expect(markup).toContain("Queue");
    expect(markup).not.toContain("Steer");
  });
});
