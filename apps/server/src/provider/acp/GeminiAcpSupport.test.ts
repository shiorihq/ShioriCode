import { describe, expect, it } from "vitest";
import { Effect, Layer, Sink, Stream } from "effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  buildGeminiAcpSpawnInput,
  classifyGeminiAuthProbeError,
  classifyGeminiAuthReadiness,
  clearGeminiAcpSupportCachesForTest,
  detectGeminiAcpFlag,
  resolveGeminiAcpApprovalMode,
  resolveGeminiAcpCliModel,
  selectGeminiAutoApprovedPermissionOption,
} from "./GeminiAcpSupport";

const encoder = new TextEncoder();

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (args: ReadonlyArray<string>) => { stdout: string; stderr: string; code: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { args: ReadonlyArray<string> };
      return Effect.succeed(mockHandle(handler(cmd.args)));
    }),
  );
}

function failingSpawnerLayer(description: string) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description,
        }),
      ),
    ),
  );
}

describe("GeminiAcpSupport", () => {
  it("omits --model only for auto/default routing", () => {
    expect(resolveGeminiAcpCliModel("auto")).toBeUndefined();
    expect(resolveGeminiAcpCliModel("")).toBeUndefined();
    expect(resolveGeminiAcpCliModel("default")).toBeUndefined();
  });

  it("passes explicit Gemini model slugs through to the CLI", () => {
    expect(resolveGeminiAcpCliModel("pro")).toBe("pro");
    expect(resolveGeminiAcpCliModel("flash")).toBe("flash");
    expect(resolveGeminiAcpCliModel("flash-lite")).toBe("flash-lite");
    expect(resolveGeminiAcpCliModel("gemini-2.5-pro")).toBe("gemini-2.5-pro");
    expect(resolveGeminiAcpCliModel("gemini-3-pro-preview")).toBe("gemini-3-pro-preview");
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
        approvalMode: "default",
        model: "auto",
      }),
    ).toMatchObject({
      command: "gemini",
      args: ["--experimental-acp", "--approval-mode", "default"],
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
        approvalMode: "yolo",
        model: "custom-gemini-model",
      }),
    ).toMatchObject({
      command: "/bin/gemini",
      args: ["--acp", "--approval-mode", "yolo", "--model", "custom-gemini-model"],
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

  it.each([
    ["pro"],
    ["flash"],
    ["flash-lite"],
    ["gemini-2.5-pro"],
    ["gemini-3-pro-preview"],
    ["custom-gemini-model"],
  ])("includes --model for explicit model %s", (model) => {
    expect(
      buildGeminiAcpSpawnInput({
        geminiSettings: {
          binaryPath: "",
          googleCloudProject: "",
          acpFlag: "",
        },
        cwd: "/workspace",
        acpFlag: "--acp",
        approvalMode: "default",
        model,
      }).args,
    ).toEqual(["--acp", "--approval-mode", "default", "--model", model]);
  });

  it("maps approval mode from runtime and interaction mode", () => {
    expect(
      resolveGeminiAcpApprovalMode({
        runtimeMode: "approval-required",
      }),
    ).toBe("default");
    expect(
      resolveGeminiAcpApprovalMode({
        runtimeMode: "full-access",
      }),
    ).toBe("yolo");
    expect(
      resolveGeminiAcpApprovalMode({
        runtimeMode: "full-access",
        interactionMode: "plan",
      }),
    ).toBe("plan");
  });

  it("does not auto-select allow_always while in plan approval mode", () => {
    const request = {
      sessionId: "session-1",
      toolCall: { toolCallId: "tool-1", title: "Edit file" },
      options: [
        { optionId: "always", name: "Always", kind: "allow_always" },
        { optionId: "once", name: "Once", kind: "allow_once" },
      ],
    } as const;

    expect(selectGeminiAutoApprovedPermissionOption(request, "plan")).toBeUndefined();
    expect(selectGeminiAutoApprovedPermissionOption(request, "default")).toBeUndefined();
    expect(selectGeminiAutoApprovedPermissionOption(request, "yolo")).toBe("always");
  });

  it("detects --experimental-acp when it is the only ACP flag in help output", async () => {
    clearGeminiAcpSupportCachesForTest();
    const result = await Effect.runPromise(
      detectGeminiAcpFlag("gemini", "0.26.0").pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            expect(args).toEqual(["--help"]);
            return { stdout: "Usage: gemini --experimental-acp\n", stderr: "", code: 0 };
          }),
        ),
      ),
    );

    expect(result).toMatchObject({
      supportedFlag: "--experimental-acp",
      reason: "help-output",
    });
  });

  it("detects --acp when stable ACP is present", async () => {
    clearGeminiAcpSupportCachesForTest();
    const result = await Effect.runPromise(
      detectGeminiAcpFlag("gemini", "0.27.0").pipe(
        Effect.provide(
          mockSpawnerLayer(() => ({
            stdout: "Usage: gemini --acp --experimental-acp\n",
            stderr: "",
            code: 0,
          })),
        ),
      ),
    );

    expect(result.supportedFlag).toBe("--acp");
  });

  it("does not fall back when help output has no ACP flag", async () => {
    clearGeminiAcpSupportCachesForTest();
    const result = await Effect.runPromise(
      detectGeminiAcpFlag("gemini", "0.25.0").pipe(
        Effect.provide(
          mockSpawnerLayer(() => ({
            stdout: "Usage: gemini --model <model>\n",
            stderr: "",
            code: 0,
          })),
        ),
      ),
    );

    expect(result).toMatchObject({
      supportedFlag: null,
      reason: "flag-not-found",
    });
  });

  it("does not fall back when the help command fails", async () => {
    clearGeminiAcpSupportCachesForTest();
    const result = await Effect.runPromise(
      detectGeminiAcpFlag("gemini", "0.25.0").pipe(
        Effect.provide(failingSpawnerLayer("spawn gemini ENOENT")),
      ),
    );

    expect(result).toMatchObject({
      supportedFlag: null,
      reason: "help-command-failed",
    });
  });

  it("classifies authenticated Gemini ACP probes", () => {
    expect(
      classifyGeminiAuthReadiness({
        outcome: "authenticated",
        oauthCacheHint: false,
      }),
    ).toMatchObject({
      status: "authenticated",
      reason: "probe-authenticated",
    });
  });

  it("classifies auth-required Gemini ACP probes", () => {
    expect(
      classifyGeminiAuthProbeError(
        EffectAcpErrors.AcpRequestError.authRequired("Authentication required"),
        false,
      ),
    ).toMatchObject({
      status: "auth_required",
      reason: "probe-auth-required",
    });
  });

  it("treats timeouts as degraded unknown auth instead of trusting OAuth files", () => {
    expect(
      classifyGeminiAuthReadiness({
        outcome: "timeout",
        oauthCacheHint: true,
      }),
    ).toMatchObject({
      status: "unknown",
      reason: "probe-timeout",
      oauthCacheHint: true,
    });
  });

  it("treats rejected OAuth files as stale", () => {
    expect(
      classifyGeminiAuthProbeError(
        EffectAcpErrors.AcpRequestError.authRequired("Please sign in again"),
        true,
      ),
    ).toMatchObject({
      status: "auth_required",
      reason: "oauth-cache-stale",
      oauthCacheHint: true,
    });
  });
});
