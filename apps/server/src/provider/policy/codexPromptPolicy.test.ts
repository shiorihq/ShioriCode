import { describe, expect, it } from "vitest";

import { buildCodexCollaborationMode } from "./codexPromptPolicy";

describe("buildCodexCollaborationMode", () => {
  it("adds terminal tool guardrails to default mode instructions", () => {
    const result = buildCodexCollaborationMode({
      interactionMode: "default",
      model: "gpt-5.3-codex",
    });

    expect(result?.settings.developer_instructions).toContain(
      "Keep exploration targeted and finite.",
    );
    expect(result?.settings.developer_instructions).toContain(
      "Do not repeatedly call `ls`, `pwd`, `glob`, or broad file-listing commands on nearby paths",
    );
    expect(result?.settings.developer_instructions).toContain(
      "run `exec_command` with `tty=true` from the start.",
    );
    expect(result?.settings.developer_instructions).toContain(
      "Do not call `write_stdin` for a buffered `exec_command` session started without `tty=true`;",
    );
  });

  it("keeps caller-provided instructions appended after the guardrails", () => {
    const personalityAppendix = [
      "## Personality Overlay",
      "Apply this as a light tone overlay on top of every other instruction in this prompt.",
      "Sound practical, grounded, and outcome-focused.",
    ].join("\n");

    const result = buildCodexCollaborationMode({
      interactionMode: "plan",
      model: "gpt-5.3-codex",
      developerInstructionsAppendix: personalityAppendix,
    });

    expect(result?.settings.developer_instructions).toContain(
      "Use `tty=true` for shells, REPLs, prompts, watch mode, long-running interactive programs",
    );
    expect(result?.settings.developer_instructions).toContain(
      "After one or two targeted exploration passes, either make the change",
    );
    expect(result?.settings.developer_instructions.endsWith(personalityAppendix)).toBe(true);
  });
});
