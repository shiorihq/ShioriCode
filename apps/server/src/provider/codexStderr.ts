const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, "g");
const CODEX_STDERR_LOG_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+:\s+(.*)$/;
const BENIGN_ERROR_LOG_SNIPPETS = [
  "apply_patch verification failed",
  "worker quit with fatal: Transport channel closed, when Auth(TokenRefreshFailed(",
  "state db missing rollout path for thread",
  "state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
  "write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
];
const RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS = [
  "not found",
  "no rollout found",
  "missing thread",
  "no such thread",
  "unknown thread",
  "does not exist",
];

export interface CodexStderrStreamState {
  readonly pendingBlock: string | null;
  readonly remainder: string;
}

function normalizeCodexStderrText(rawText: string): string {
  return rawText.replaceAll(ANSI_ESCAPE_REGEX, "");
}

function firstCodexStderrLine(rawText: string): string {
  const [firstLine = ""] = normalizeCodexStderrText(rawText).split(/\r?\n/u);
  return firstLine.trim();
}

function isStructuredCodexStderrLine(rawLine: string): boolean {
  return CODEX_STDERR_LOG_REGEX.test(firstCodexStderrLine(rawLine));
}

function shouldBufferCodexStderrBlock(rawLine: string): boolean {
  const firstLine = firstCodexStderrLine(rawLine);
  return isStructuredCodexStderrLine(firstLine) && firstLine.endsWith(":");
}

function appendCodexStderrLine(
  rawLine: string,
  emittedLines: string[],
  pendingBlock: string | null,
): string | null {
  if (pendingBlock !== null) {
    if (isStructuredCodexStderrLine(rawLine)) {
      emittedLines.push(pendingBlock);
      if (shouldBufferCodexStderrBlock(rawLine)) {
        return rawLine;
      }
      emittedLines.push(rawLine);
      return null;
    }

    return `${pendingBlock}\n${rawLine}`;
  }

  if (shouldBufferCodexStderrBlock(rawLine)) {
    return rawLine;
  }

  emittedLines.push(rawLine);
  return null;
}

export function consumeCodexStderrChunk(
  state: CodexStderrStreamState,
  chunk: string,
): { emittedLines: string[]; state: CodexStderrStreamState } {
  const text = `${state.remainder}${chunk}`;
  const parts = text.split(/\r?\n/u);
  const remainder = parts.pop() ?? "";
  const emittedLines: string[] = [];
  let pendingBlock = state.pendingBlock;

  for (const rawLine of parts) {
    pendingBlock = appendCodexStderrLine(rawLine, emittedLines, pendingBlock);
  }

  return {
    emittedLines,
    state: {
      pendingBlock,
      remainder,
    },
  };
}

export function flushCodexStderrStream(state: CodexStderrStreamState): {
  emittedLines: string[];
  state: CodexStderrStreamState;
} {
  const emittedLines: string[] = [];
  let pendingBlock = state.pendingBlock;

  if (state.remainder.length > 0) {
    pendingBlock = appendCodexStderrLine(state.remainder, emittedLines, pendingBlock);
  }

  if (pendingBlock !== null) {
    emittedLines.push(pendingBlock);
  }

  return {
    emittedLines,
    state: {
      pendingBlock: null,
      remainder: "",
    },
  };
}

export function classifyCodexStderrLine(rawLine: string): { message: string } | null {
  const line = normalizeCodexStderrText(rawLine).trim();
  if (!line) {
    return null;
  }

  const match = firstCodexStderrLine(line).match(CODEX_STDERR_LOG_REGEX);
  if (match) {
    const level = match[1];
    if (level && level !== "ERROR") {
      return null;
    }

    const isBenignError = BENIGN_ERROR_LOG_SNIPPETS.some((snippet) => line.includes(snippet));
    if (isBenignError) {
      return null;
    }
  }

  return { message: line };
}

export function isRecoverableThreadResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message.includes("thread/resume")) {
    return false;
  }

  return RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
}
