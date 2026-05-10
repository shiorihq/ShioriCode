import { describe, expect, it } from "vitest";

import {
  buildCursorAgentArgs,
  parseCursorCliModelsOutput,
  resolveCursorAgentCommand,
} from "./CursorProvider.ts";

describe("CursorProvider helpers", () => {
  it("classifies direct and wrapper Cursor binaries", () => {
    expect(resolveCursorAgentCommand("agent")).toEqual({
      command: "agent",
      argsPrefix: [],
      kind: "direct",
    });
    expect(resolveCursorAgentCommand("cursor-agent")).toEqual({
      command: "cursor-agent",
      argsPrefix: [],
      kind: "direct",
    });
    expect(resolveCursorAgentCommand("/Applications/Cursor.app/Contents/MacOS/cursor")).toEqual({
      command: "/Applications/Cursor.app/Contents/MacOS/cursor",
      argsPrefix: ["agent"],
      kind: "wrapper",
    });
    expect(resolveCursorAgentCommand("/opt/bin/custom")).toEqual({
      command: "/opt/bin/custom",
      argsPrefix: [],
      kind: "direct",
    });
  });

  it("builds wrapper and endpoint prefixes for about, models, and acp commands", () => {
    const settings = {
      binaryPath: "/path/to/cursor",
      apiEndpoint: "https://cursor.example.test",
    };

    expect(buildCursorAgentArgs(settings, ["about"])).toEqual([
      "agent",
      "-e",
      "https://cursor.example.test",
      "about",
    ]);
    expect(buildCursorAgentArgs(settings, ["models"])).toEqual([
      "agent",
      "-e",
      "https://cursor.example.test",
      "models",
    ]);
    expect(buildCursorAgentArgs(settings, ["acp"])).toEqual([
      "agent",
      "-e",
      "https://cursor.example.test",
      "acp",
    ]);
  });

  it("parses Cursor CLI JSON model inventories", () => {
    const models = parseCursorCliModelsOutput({
      stdout: JSON.stringify({
        models: [
          { id: "default", name: "Auto" },
          { slug: "composer", displayName: "Cursor Composer" },
        ],
      }),
      stderr: "",
      code: 0,
    });

    expect(models.map((model) => [model.slug, model.name])).toEqual([
      ["default", "Cursor (Auto)"],
      ["composer", "Cursor Composer"],
    ]);
  });

  it("parses Cursor CLI line model inventories", () => {
    const models = parseCursorCliModelsOutput({
      stdout: "Available models:\n- default (default)\n- composer\n",
      stderr: "",
      code: 0,
    });

    expect(models.map((model) => model.slug)).toEqual(["default", "composer"]);
  });
});
