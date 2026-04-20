import { describe, expect, it } from "vitest";

import {
  classifyCodexStderrLine,
  consumeCodexStderrChunk,
  flushCodexStderrStream,
} from "./codexStderr";

describe("classifyCodexStderrLine", () => {
  it("suppresses the non-fatal closed-stdin router warning", () => {
    expect(
      classifyCodexStderrLine(
        "2026-04-18T17:43:55.650065Z ERROR codex_core::tools::router: error=write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
      ),
    ).toBeNull();
  });

  it("keeps unexpected error lines", () => {
    const line = "2026-04-18T17:43:55.650065Z ERROR codex_core::tools::router: error=boom";

    expect(classifyCodexStderrLine(line)).toEqual({ message: line });
  });

  it("suppresses apply_patch verification failures", () => {
    expect(
      classifyCodexStderrLine(
        [
          "2026-04-19T18:46:31.167650Z ERROR codex_core::tools::router: error=apply_patch verification failed: Failed to find expected lines in /tmp/file.ts:",
          "await using _ = await mountMenu({",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  it("suppresses MCP refresh-token transport errors", () => {
    expect(
      classifyCodexStderrLine(
        '2026-04-19T21:40:03.595702Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Auth(TokenRefreshFailed("Server returned error response: invalid_grant: Invalid refresh token"))',
      ),
    ).toBeNull();
  });
});

describe("consumeCodexStderrChunk", () => {
  it("buffers split stderr lines across chunks", () => {
    const first = consumeCodexStderrChunk(
      { pendingBlock: null, remainder: "" },
      "2026-04-19T18:46:31.167650Z ERROR codex_core::tools::router: error=bo",
    );
    expect(first.emittedLines).toEqual([]);

    const second = consumeCodexStderrChunk(first.state, "om\n");
    expect(second.emittedLines).toEqual([
      "2026-04-19T18:46:31.167650Z ERROR codex_core::tools::router: error=boom",
    ]);
  });

  it("groups colon-terminated structured stderr with continuation lines", () => {
    const chunk = [
      "2026-04-19T18:46:31.167650Z ERROR codex_core::tools::router: error=apply_patch verification failed: Failed to find expected lines in /tmp/file.ts:",
      "await using _ = await mountMenu({",
      "  modelSelection,",
    ].join("\n");

    const consumed = consumeCodexStderrChunk({ pendingBlock: null, remainder: "" }, `${chunk}\n`);
    expect(consumed.emittedLines).toEqual([]);

    const flushed = flushCodexStderrStream(consumed.state);
    expect(flushed.emittedLines).toEqual([chunk]);
  });

  it("flushes a buffered multiline block when the next structured log arrives", () => {
    const consumed = consumeCodexStderrChunk(
      { pendingBlock: null, remainder: "" },
      [
        "2026-04-19T18:46:31.167650Z ERROR codex_core::tools::router: error=apply_patch verification failed: Failed to find expected lines in /tmp/file.ts:",
        "await using _ = await mountMenu({",
        "2026-04-19T18:46:32.000000Z ERROR codex_core::runtime: boom",
      ].join("\n") + "\n",
    );

    expect(consumed.emittedLines).toEqual([
      [
        "2026-04-19T18:46:31.167650Z ERROR codex_core::tools::router: error=apply_patch verification failed: Failed to find expected lines in /tmp/file.ts:",
        "await using _ = await mountMenu({",
      ].join("\n"),
      "2026-04-19T18:46:32.000000Z ERROR codex_core::runtime: boom",
    ]);
  });
});
