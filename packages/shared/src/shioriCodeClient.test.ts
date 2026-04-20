import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ProjectId, ThreadId } from "contracts";

import {
  resolveBundledBackendEntry,
  resolveCliBaseDir,
  resolveStartupThreadSelection,
} from "./shioriCodeClient";

describe("resolveCliBaseDir", () => {
  it("expands explicit home-relative paths", () => {
    expect(resolveCliBaseDir("~/demo")).toContain("/demo");
  });
});

describe("resolveBundledBackendEntry", () => {
  it("returns the colocated backend entry when present", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-client-"));
    const entryPath = path.join(tempDir, "bin.mjs");
    const bundledBackendEntry = path.join(tempDir, "backend", "bin.mjs");

    fs.mkdirSync(path.dirname(bundledBackendEntry), { recursive: true });
    fs.writeFileSync(entryPath, "");
    fs.writeFileSync(bundledBackendEntry, "");

    try {
      expect(resolveBundledBackendEntry(pathToFileURL(entryPath).href)).toBe(bundledBackendEntry);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns null when no bundled backend is present", () => {
    expect(resolveBundledBackendEntry(import.meta.url)).toBeNull();
  });
});

describe("resolveStartupThreadSelection", () => {
  it("prefers an explicit thread id without creating anything new", async () => {
    const rpc = {
      server: {
        getSettings: vi.fn(),
      },
      orchestration: {
        dispatchCommand: vi.fn(),
      },
    } as const;

    const selection = await resolveStartupThreadSelection({
      rpc: rpc as never,
      snapshot: {
        snapshotSequence: 1,
        updatedAt: "2026-04-17T10:00:00.000Z",
        projects: [],
        threads: [
          {
            id: ThreadId.makeUnsafe("thread-1"),
            projectId: ProjectId.makeUnsafe("project-1"),
            title: "Thread One",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.4",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            parentThreadId: null,
            branchSourceTurnId: null,
            branch: null,
            worktreePath: null,
            tag: null,
            createdAt: "2026-04-17T10:00:00.000Z",
            updatedAt: "2026-04-17T10:00:00.000Z",
            archivedAt: null,
            latestTurn: null,
            messages: [],
            proposedPlans: [],
            activities: [],
            checkpoints: [],
            session: null,
            deletedAt: null,
            resumeState: "resumed",
          },
        ],
      },
      threadId: "thread-1",
    });

    expect(selection.threadId).toBe("thread-1");
    expect(rpc.server.getSettings).not.toHaveBeenCalled();
  });

  it("creates a new thread when explicitly requested", async () => {
    const dispatchCommand = vi.fn(async () => ({ sequence: 1 }));
    const getSettings = vi.fn(async () => ({
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
    }));
    const rpc = {
      server: {
        getSettings,
      },
      orchestration: {
        dispatchCommand,
      },
    } as const;

    const selection = await resolveStartupThreadSelection({
      rpc: rpc as never,
      snapshot: {
        snapshotSequence: 1,
        updatedAt: "2026-04-17T10:00:00.000Z",
        projects: [
          {
            id: ProjectId.makeUnsafe("project-1"),
            title: "Project One",
            workspaceRoot: "/tmp/project-one",
            defaultModelSelection: {
              provider: "codex",
              model: "gpt-5.4",
            },
            scripts: [],
            createdAt: "2026-04-17T10:00:00.000Z",
            updatedAt: "2026-04-17T10:00:00.000Z",
            deletedAt: null,
          },
        ],
        threads: [],
      },
      projectId: "project-1",
      newThread: true,
    });

    expect(selection.projectId).toBe("project-1");
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.create",
        projectId: "project-1",
      }),
    );
    expect(selection.threadId).toBeTruthy();
  });
});
