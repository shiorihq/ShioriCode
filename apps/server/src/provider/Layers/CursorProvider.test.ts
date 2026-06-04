import type { SDKModel } from "@cursor/sdk";
import { describe, expect, it, vi } from "vitest";

import {
  buildCursorAgentArgs,
  buildCursorDiscoveredModelsFromSdkModels,
  parseCursorCliModelsOutput,
  resolveCursorAgentCommand,
} from "./CursorProvider.ts";

vi.mock("@cursor/sdk", () => ({
  Cursor: {
    models: {
      list: vi.fn(),
    },
  },
}));

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

  it("builds wrapper and endpoint prefixes for Cursor CLI commands", () => {
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
  });

  it("maps Cursor SDK model parameters and variants into provider models", () => {
    const models = buildCursorDiscoveredModelsFromSdkModels([
      {
        id: "composer",
        displayName: "Composer",
        parameters: [
          {
            id: "reasoning_effort",
            displayName: "Reasoning",
            values: [
              { value: "low", displayName: "Low" },
              { value: "extra-high", displayName: "Extra High" },
            ],
          },
          {
            id: "context",
            values: [
              { value: "short", displayName: "Short" },
              { value: "long", displayName: "Long" },
            ],
          },
          {
            id: "fast",
            values: [{ value: "true" }, { value: "false" }],
          },
          {
            id: "thinking",
            values: [{ value: "true" }, { value: "false" }],
          },
        ],
        variants: [
          {
            displayName: "Fast",
            params: [{ id: "fast", value: "true" }],
          },
        ],
      } satisfies SDKModel,
    ]);

    expect(models.map((model) => [model.slug, model.name])).toEqual([
      ["composer", "Cursor Composer"],
      ["composer[fast=true]", "Cursor Composer Fast"],
    ]);
    expect(models[0]?.capabilities).toMatchObject({
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "xhigh", label: "Extra High" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: true,
      contextWindowOptions: [
        { value: "short", label: "Short" },
        { value: "long", label: "Long" },
      ],
      promptInjectedEffortLevels: [],
    });
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
