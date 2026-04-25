import { describe, expect, it } from "vitest";

import { buildGeminiAcpSpawnInput, resolveGeminiAcpCliModel } from "./GeminiAcpSupport";

describe("GeminiAcpSupport", () => {
  it("lets Gemini ACP own built-in model routing", () => {
    expect(resolveGeminiAcpCliModel("auto")).toBeUndefined();
    expect(resolveGeminiAcpCliModel("pro")).toBeUndefined();
    expect(resolveGeminiAcpCliModel("flash")).toBeUndefined();
    expect(resolveGeminiAcpCliModel("gemini-2.5-pro")).toBeUndefined();
  });

  it("passes through custom model slugs", () => {
    expect(resolveGeminiAcpCliModel("custom-gemini-model")).toBe("custom-gemini-model");
  });

  it("omits --model for built-in routed models", () => {
    expect(
      buildGeminiAcpSpawnInput({
        geminiSettings: {
          binaryPath: "",
          googleCloudProject: "",
          acpFlag: "",
        },
        cwd: "/workspace",
        acpFlag: "--experimental-acp",
        model: "auto",
      }),
    ).toMatchObject({
      command: "gemini",
      args: ["--experimental-acp"],
      cwd: "/workspace",
    });
  });

  it("includes --model for custom models", () => {
    expect(
      buildGeminiAcpSpawnInput({
        geminiSettings: {
          binaryPath: "/bin/gemini",
          googleCloudProject: "project-id",
          acpFlag: "",
        },
        cwd: "/workspace",
        acpFlag: "--acp",
        model: "custom-gemini-model",
      }),
    ).toMatchObject({
      command: "/bin/gemini",
      args: ["--acp", "--model", "custom-gemini-model"],
      cwd: "/workspace",
      env: {
        GEMINI_API_KEY: undefined,
        GOOGLE_API_KEY: undefined,
        GOOGLE_GENAI_USE_VERTEXAI: undefined,
        GOOGLE_APPLICATION_CREDENTIALS: undefined,
        GOOGLE_CLOUD_PROJECT: "project-id",
        GOOGLE_CLOUD_PROJECT_ID: "project-id",
      },
    });
  });
});
