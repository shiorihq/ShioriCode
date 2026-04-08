import { describe, expect, it, vi } from "vitest";

describe("codexBinaryPath", () => {
  it("prefers the Codex app bundled binary when the default PATH binary is older", async () => {
    vi.resetModules();
    const accessSync = vi.fn((path: string) => {
      if (path !== "/Applications/Codex.app/Contents/Resources/codex") {
        throw new Error("missing");
      }
    });
    const spawnSync = vi.fn((binaryPath: string) => {
      if (binaryPath === "codex") {
        return { stdout: "codex-cli 0.75.0", stderr: "", status: 0 };
      }
      if (binaryPath === "/Applications/Codex.app/Contents/Resources/codex") {
        return { stdout: "codex-cli 0.118.0-alpha.2", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 1 };
    });

    vi.doMock("node:fs", () => ({
      default: {
        accessSync,
        constants: { X_OK: 1 },
      },
    }));
    vi.doMock("node:child_process", () => ({ spawnSync }));

    const { resolvePreferredCodexBinaryPath, supportsCodexReasoningSummary } =
      await import("./codexBinaryPath");

    expect(resolvePreferredCodexBinaryPath("codex")).toBe(
      "/Applications/Codex.app/Contents/Resources/codex",
    );
    expect(supportsCodexReasoningSummary("/Applications/Codex.app/Contents/Resources/codex")).toBe(
      true,
    );
  });

  it("keeps an explicit custom binary path", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      default: {
        accessSync: vi.fn(),
        constants: { X_OK: 1 },
      },
    }));
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({ stdout: "", stderr: "", status: 1 })),
    }));

    const { resolvePreferredCodexBinaryPath } = await import("./codexBinaryPath");

    expect(resolvePreferredCodexBinaryPath("/custom/codex")).toBe("/custom/codex");
  });
});
