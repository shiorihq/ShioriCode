import { describe, expect, it } from "vitest";

import { buildCursorAcpSpawnInput, resolveSupportedCursorModel } from "./CursorAcpSupport.ts";

const modelConfig = (currentValue = "default") =>
  [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue,
      options: [
        { value: "default", name: "Auto" },
        { value: "composer", name: "Composer" },
      ],
    },
  ] as const;

describe("CursorAcpSupport", () => {
  it("launches direct agent binaries without a wrapper prefix", () => {
    expect(
      buildCursorAcpSpawnInput({ binaryPath: "agent", apiEndpoint: "" }, "/workspace"),
    ).toMatchObject({
      command: "agent",
      args: ["acp"],
      cwd: "/workspace",
    });

    expect(
      buildCursorAcpSpawnInput({ binaryPath: "cursor-agent", apiEndpoint: "" }, "/workspace"),
    ).toMatchObject({
      command: "cursor-agent",
      args: ["acp"],
      cwd: "/workspace",
    });
  });

  it("launches Cursor wrapper binaries through the agent subcommand", () => {
    expect(
      buildCursorAcpSpawnInput(
        { binaryPath: "/Applications/Cursor.app/Contents/MacOS/cursor", apiEndpoint: "" },
        "/workspace",
      ),
    ).toMatchObject({
      command: "/Applications/Cursor.app/Contents/MacOS/cursor",
      args: ["agent", "acp"],
      cwd: "/workspace",
    });
  });

  it("keeps unknown custom binaries direct", () => {
    expect(
      buildCursorAcpSpawnInput(
        { binaryPath: "/opt/bin/my-cursor-agent", apiEndpoint: "" },
        "/workspace",
      ),
    ).toMatchObject({
      command: "/opt/bin/my-cursor-agent",
      args: ["acp"],
      cwd: "/workspace",
    });
  });

  it("reports requested, applied, and fallback reason when Cursor substitutes a model", () => {
    expect(
      resolveSupportedCursorModel({
        requestedModel: "composer-2",
        configOptions: modelConfig(),
      }),
    ).toEqual({
      requestedModel: "composer-2",
      appliedModel: "composer",
      fallbackReason: "Requested Cursor model 'composer-2' is unavailable; using 'composer'.",
    });
  });
});
