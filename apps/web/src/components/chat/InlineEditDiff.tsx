import type { DiffsHighlighter, SupportedLanguages, ThemedToken } from "@pierre/diffs";
import { memo, useEffect, useMemo, useState } from "react";
import {
  IconCopyOutline24 as CopyIcon,
  IconCheckOutline24 as CheckIcon,
} from "nucleo-core-outline-24";
import { cn } from "~/lib/utils";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useTheme } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { CHAT_THREAD_BODY_CLASS } from "../../chatTypography";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DiffLine {
  type: "added" | "removed" | "context";
  content: string;
  oldLineNo: number | null;
  newLineNo: number | null;
}

interface ParsedEditDiff {
  filePath: string | null;
  lines: DiffLine[];
  additions: number;
  deletions: number;
}

const MAX_PRIMITIVE_PARSE_CACHE_ENTRIES = 200;
const parseEditDiffObjectCache = new WeakMap<object, Map<string, ParsedEditDiff | null>>();
const parseEditDiffPrimitiveCache = new Map<string, ParsedEditDiff | null>();

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Extract just the filename from a full or relative path. */
export function extractBasename(path: string): string {
  const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return lastSep >= 0 ? path.substring(lastSep + 1) : path;
}

// ---------------------------------------------------------------------------
// Syntax highlighting
// ---------------------------------------------------------------------------

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mts: "typescript",
  cts: "typescript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  vue: "vue",
  svelte: "svelte",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  mdx: "mdx",
  sh: "shellscript",
  bash: "bash",
  zsh: "zsh",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  fs: "fsharp",
  lua: "lua",
  zig: "zig",
  prisma: "prisma",
  xml: "xml",
  svg: "xml",
  dockerfile: "dockerfile",
};

function langFromPath(filePath: string | null): string {
  if (!filePath) return "text";
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) {
    const name = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
    if (name === "dockerfile") return "dockerfile";
    if (name === "makefile") return "makefile";
    return "text";
  }
  const ext = filePath.substring(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? "text";
}

const highlighterCache = new Map<string, Promise<DiffsHighlighter>>();
const diffsModule = import("@pierre/diffs");

function getHighlighter(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterCache.get(language);
  if (cached) return cached;

  const promise = diffsModule
    .then(({ getSharedHighlighter }) =>
      getSharedHighlighter({
        themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
        langs: [language as SupportedLanguages],
        preferredHighlighter: "shiki-js",
      }),
    )
    .catch((err) => {
      highlighterCache.delete(language);
      if (language === "text") throw err;
      return getHighlighter("text");
    });
  highlighterCache.set(language, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Output shape detection
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function firstDisplayDiffPair(
  value: unknown,
): { oldText: string; newText: string; path: string | null } | null {
  const record = asRecord(value);
  const display = Array.isArray(record?.display) ? record.display : null;
  if (!display) return null;

  for (const entry of display) {
    const diff = asRecord(entry);
    if (diff?.type !== "diff") continue;

    const oldText = asString(diff.old_text);
    const newText = asString(diff.new_text);
    if (oldText != null && newText != null) {
      return {
        oldText,
        newText,
        path: asString(diff.path),
      };
    }
  }

  return null;
}

/**
 * Resolve the most specific nested data container.
 * Claude adapter wraps as `{ toolName, input, result }` where `result`
 * contains the SDK tool result blocks. Codex and Shiori put data at top-level.
 */
function resolveInnerData(output: unknown): Record<string, unknown> | null {
  const top = asRecord(output);
  if (!top) return null;

  // Claude adapter nests: { result: { content: [{ type: "text", text: "..." }] } }
  const result = asRecord(top.result);
  if (result) {
    // Try to extract text content from Claude tool_result blocks
    const content = result.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const rec = asRecord(block);
        if (rec?.type === "text" && typeof rec.text === "string") {
          try {
            const parsed = JSON.parse(rec.text);
            const inner = asRecord(parsed);
            if (inner) return inner;
          } catch {
            // not JSON, skip
          }
        }
      }
    }
    return result;
  }

  // Codex / Shiori: data at top level
  return top;
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

/** Build diff lines from explicit old_string / new_string (Claude Edit tool input). */
function diffFromOldNew(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const lines: DiffLine[] = [];

  let oldIdx = 0;
  let newIdx = 0;

  // Simple LCS-free approach: show removed then added with context detection.
  // For inline diffs this is sufficient — we show what was replaced.
  for (const line of oldLines) {
    lines.push({ type: "removed", content: line, oldLineNo: ++oldIdx, newLineNo: null });
  }
  for (const line of newLines) {
    lines.push({ type: "added", content: line, oldLineNo: null, newLineNo: ++newIdx });
  }

  return lines;
}

/** Parse a unified diff patch string into DiffLines. */
function diffFromUnifiedPatch(patch: string): DiffLine[] {
  const rawLines = patch.split("\n");
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const raw of rawLines) {
    // Skip diff header lines
    if (
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("\\ No newline")
    ) {
      continue;
    }

    // Hunk header
    const hunkMatch = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(raw);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1]!, 10) - 1;
      newLine = parseInt(hunkMatch[2]!, 10) - 1;
      continue;
    }

    if (raw.startsWith("+")) {
      newLine++;
      lines.push({ type: "added", content: raw.slice(1), oldLineNo: null, newLineNo: newLine });
    } else if (raw.startsWith("-")) {
      oldLine++;
      lines.push({ type: "removed", content: raw.slice(1), oldLineNo: oldLine, newLineNo: null });
    } else {
      // Context line (starts with space or is empty)
      oldLine++;
      newLine++;
      lines.push({
        type: "context",
        content: raw.startsWith(" ") ? raw.slice(1) : raw,
        oldLineNo: oldLine,
        newLineNo: newLine,
      });
    }
  }

  return lines;
}

function filePathFromUnifiedPatch(patch: string): string | null {
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("+++ b/") || raw.startsWith("--- a/")) {
      const candidate = raw.slice(6).trim();
      if (candidate.length > 0 && candidate !== "/dev/null") {
        return candidate;
      }
    }
    if (raw.startsWith("rename to ") || raw.startsWith("rename from ")) {
      const candidate = raw.replace(/^rename (?:to|from) /u, "").trim();
      if (candidate.length > 0 && candidate !== "/dev/null") {
        return candidate;
      }
    }
  }
  return null;
}

/** Parse structuredPatch array (Claude SDK format) into DiffLines. */
function diffFromStructuredPatch(
  patches: Array<{
    oldStart?: number;
    newStart?: number;
    lines?: string[];
  }>,
): DiffLine[] {
  const lines: DiffLine[] = [];

  for (const hunk of patches) {
    let oldLine = (hunk.oldStart ?? 1) - 1;
    let newLine = (hunk.newStart ?? 1) - 1;

    for (const raw of hunk.lines ?? []) {
      if (raw.startsWith("+")) {
        newLine++;
        lines.push({ type: "added", content: raw.slice(1), oldLineNo: null, newLineNo: newLine });
      } else if (raw.startsWith("-")) {
        oldLine++;
        lines.push({
          type: "removed",
          content: raw.slice(1),
          oldLineNo: oldLine,
          newLineNo: null,
        });
      } else {
        oldLine++;
        newLine++;
        lines.push({
          type: "context",
          content: raw.startsWith(" ") ? raw.slice(1) : raw,
          oldLineNo: oldLine,
          newLineNo: newLine,
        });
      }
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

const MAX_DIFF_LINES = 80;
const WRITE_TOOL_NAME_ALIASES = new Set(["write", "write_file", "writefile"]);
const KIMI_STR_REPLACE_TOOL_NAME = "strreplacefile";

function normalizeToolName(value: string): string {
  return value
    .replace(/[.\s-]+/g, "_")
    .trim()
    .toLowerCase();
}

export function parseEditDiff(output: unknown, detail?: string): ParsedEditDiff | null {
  const detailKey = detail ?? "";
  if (output && typeof output === "object") {
    const cachedByDetail = parseEditDiffObjectCache.get(output as object);
    const cached = cachedByDetail?.get(detailKey);
    if (cached !== undefined) {
      return cached;
    }
  } else {
    const primitiveKey = `${typeof output}:${String(output)}\u0000${detailKey}`;
    const cached = parseEditDiffPrimitiveCache.get(primitiveKey);
    if (cached !== undefined) {
      return cached;
    }
  }

  const storeParsedDiff = (value: ParsedEditDiff | null): ParsedEditDiff | null => {
    if (output && typeof output === "object") {
      const objectKey = output as object;
      const existingByDetail = parseEditDiffObjectCache.get(objectKey);
      if (existingByDetail) {
        existingByDetail.set(detailKey, value);
      } else {
        parseEditDiffObjectCache.set(objectKey, new Map([[detailKey, value]]));
      }
      return value;
    }

    const primitiveKey = `${typeof output}:${String(output)}\u0000${detailKey}`;
    parseEditDiffPrimitiveCache.set(primitiveKey, value);
    if (parseEditDiffPrimitiveCache.size > MAX_PRIMITIVE_PARSE_CACHE_ENTRIES) {
      const oldestKey = parseEditDiffPrimitiveCache.keys().next().value;
      if (typeof oldestKey === "string") {
        parseEditDiffPrimitiveCache.delete(oldestKey);
      }
    }
    return value;
  };

  const top = asRecord(output);
  const data = resolveInnerData(output);
  if (!data) return storeParsedDiff(null);
  const input = asRecord(data.input);
  const topInput = asRecord(top?.input);
  const inputEdit = asRecord(input?.edit);
  const topInputEdit = asRecord(topInput?.edit);
  const topToolName = asString(top?.toolName) ?? asString(data.toolName) ?? null;
  const normalizedTopToolName = topToolName !== null ? normalizeToolName(topToolName) : null;

  // Extract file path from various locations
  const filePath =
    asString(data.filePath) ??
    asString(data.path) ??
    asString(data.relativePath) ??
    asString(data.filename) ??
    asString(topInput?.path) ??
    asString(topInput?.file_path) ??
    asString(input?.file_path) ??
    asString(input?.path) ??
    detail ??
    null;

  // Strategy 1: structuredPatch array (Claude SDK FileEditOutput / FileWriteOutput)
  if (Array.isArray(data.structuredPatch) && data.structuredPatch.length > 0) {
    const lines = diffFromStructuredPatch(data.structuredPatch);
    if (lines.length > 0) {
      return storeParsedDiff(buildResult(filePath, lines));
    }
  }

  // Strategy 2: gitDiff.patch string
  const gitDiff = asRecord(data.gitDiff);
  const patchStr = asString(gitDiff?.patch);
  if (patchStr) {
    const lines = diffFromUnifiedPatch(patchStr);
    if (lines.length > 0) {
      return storeParsedDiff(buildResult(filePath, lines));
    }
  }

  // Strategy 3: top-level patch / diff string
  const topPatch = asString(data.patch) ?? asString(data.diff);
  if (topPatch) {
    const lines = diffFromUnifiedPatch(topPatch);
    if (lines.length > 0) {
      return storeParsedDiff(buildResult(filePath ?? filePathFromUnifiedPatch(topPatch), lines));
    }
  }

  // Strategy 4: patch string captured in tool input (Shiori/Codex patch-style edit tools)
  const inputPatch = asString(input?.patch) ?? asString(topInput?.patch);
  if (inputPatch) {
    const lines = diffFromUnifiedPatch(inputPatch);
    if (lines.length > 0) {
      return storeParsedDiff(buildResult(filePath ?? filePathFromUnifiedPatch(inputPatch), lines));
    }
  }

  // Strategy 5: Kimi StrReplaceFile result display entries include contextual diff blocks.
  // Kimi write tools may also emit display diffs; keep those on the normal write-file path.
  const displayDiff =
    normalizedTopToolName === KIMI_STR_REPLACE_TOOL_NAME
      ? (firstDisplayDiffPair(data) ??
        firstDisplayDiffPair(top?.result) ??
        firstDisplayDiffPair(top))
      : null;
  if (displayDiff) {
    const lines = diffFromOldNew(displayDiff.oldText, displayDiff.newText);
    if (lines.length > 0) {
      return storeParsedDiff(buildResult(filePath ?? displayDiff.path, lines));
    }
  }

  // Strategy 6: old_string / new_string from input (Claude Edit and Kimi StrReplaceFile tools)
  const oldString =
    asString(input?.old_string) ??
    asString(topInput?.old_string) ??
    asString(inputEdit?.old) ??
    asString(topInputEdit?.old) ??
    asString(data.oldString) ??
    asString(top?.oldString);
  const newString =
    asString(input?.new_string) ??
    asString(topInput?.new_string) ??
    asString(inputEdit?.new) ??
    asString(topInputEdit?.new) ??
    asString(data.newString) ??
    asString(top?.newString);
  if (oldString != null && newString != null) {
    const lines = diffFromOldNew(oldString, newString);
    if (lines.length > 0) {
      return storeParsedDiff(buildResult(filePath, lines));
    }
  }

  // Strategy 7: bytes-only file writes — show the attempted file contents as a full write diff
  // whenever the input content survived lifecycle collapsing, even if the tool name is absent.
  const isWriteTool =
    normalizedTopToolName !== null && WRITE_TOOL_NAME_ALIASES.has(normalizedTopToolName);
  const writeContent = asString(topInput?.content) ?? asString(input?.content);
  if (writeContent != null && (isWriteTool || filePath !== null)) {
    const lines = diffFromOldNew("", writeContent);
    if (lines.length > 0) {
      return storeParsedDiff(buildResult(filePath, lines));
    }
  }

  // Strategy 8: Codex fileChange format — item.changes[] with unified diffs
  const item = asRecord(data.item);
  if (item && Array.isArray(item.changes)) {
    for (const change of item.changes) {
      const changeRec = asRecord(change);
      if (!changeRec) continue;
      const changePath = asString(changeRec.path);
      const changeDiff = asString(changeRec.diff);
      if (changeDiff) {
        const lines = diffFromUnifiedPatch(changeDiff);
        if (lines.length > 0) {
          return storeParsedDiff(buildResult(changePath ?? filePath, lines));
        }
      }
    }
  }

  return storeParsedDiff(null);
}

function buildResult(filePath: string | null, lines: DiffLine[]): ParsedEditDiff {
  const truncated = lines.length > MAX_DIFF_LINES ? lines.slice(0, MAX_DIFF_LINES) : lines;
  let additions = 0;
  let deletions = 0;
  for (const line of truncated) {
    if (line.type === "added") additions++;
    if (line.type === "removed") deletions++;
  }
  return { filePath, lines: truncated, additions, deletions };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const LINE_TYPE_STYLES = {
  added: "bg-success/8 text-foreground/85",
  removed: "bg-destructive/8 text-foreground/85",
  context: "text-foreground/60",
} as const;

const LINE_GUTTER_STYLES = {
  added: "text-success/60",
  removed: "text-destructive/60",
  context: "text-foreground/30",
} as const;

const LINE_PREFIX = {
  added: "+",
  removed: "-",
  context: " ",
} as const;

export const InlineEditDiff = memo(function InlineEditDiff(props: {
  diff: ParsedEditDiff;
  className?: string;
}) {
  const { diff, className } = props;
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const { resolvedTheme } = useTheme();
  const themeName = resolveDiffThemeName(resolvedTheme);
  const lang = useMemo(() => langFromPath(diff.filePath), [diff.filePath]);

  const [tokensByLine, setTokensByLine] = useState<ReadonlyArray<ThemedToken[]> | null>(null);

  useEffect(() => {
    if (lang === "text") {
      setTokensByLine(null);
      return;
    }

    let cancelled = false;
    const code = diff.lines.map((l) => l.content).join("\n");

    getHighlighter(lang)
      .then((highlighter) => {
        if (cancelled) return;
        const result = highlighter.codeToTokens(code, {
          lang: lang as SupportedLanguages,
          theme: themeName,
        });
        if (!cancelled) {
          setTokensByLine(result.tokens);
        }
      })
      .catch(() => {
        /* fall back to plain text */
      });

    return () => {
      cancelled = true;
    };
  }, [diff.lines, lang, themeName]);

  const gutterWidth = useMemo(() => {
    let maxLine = 0;
    for (const line of diff.lines) {
      if (line.oldLineNo != null && line.oldLineNo > maxLine) maxLine = line.oldLineNo;
      if (line.newLineNo != null && line.newLineNo > maxLine) maxLine = line.newLineNo;
    }
    return Math.max(2, String(maxLine).length);
  }, [diff.lines]);

  return (
    <div
      data-inline-diff="true"
      className={cn("overflow-hidden rounded-md border border-border/50", className)}
    >
      {/* Header */}
      <div
        className={cn(
          CHAT_THREAD_BODY_CLASS,
          "flex items-center gap-2 border-b border-border/50 px-3 py-1.5 font-mono text-muted-foreground",
        )}
      >
        {diff.filePath && (
          <span className="truncate font-medium text-foreground/80" title={diff.filePath}>
            {extractBasename(diff.filePath)}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums">
          {diff.additions > 0 && <span className="text-success">+{diff.additions}</span>}
          {diff.deletions > 0 && <span className="text-destructive">-{diff.deletions}</span>}
        </span>
        {diff.filePath && (
          <button
            type="button"
            className="shrink-0 text-muted-foreground/60 transition-colors hover:text-foreground/80"
            title={isCopied ? "Copied" : "Copy file path"}
            aria-label={isCopied ? "Copied" : "Copy file path"}
            onClick={() => copyToClipboard(diff.filePath!)}
          >
            {isCopied ? (
              <CheckIcon className="size-3.5 text-success" />
            ) : (
              <CopyIcon className="size-3.5" />
            )}
          </button>
        )}
      </div>

      {/* Diff body */}
      <div
        data-inline-diff-body="true"
        className="max-h-[min(24rem,55vh)] overflow-auto overscroll-contain"
      >
        <pre className={cn(CHAT_THREAD_BODY_CLASS, "font-mono leading-5")}>
          {diff.lines.map((line, lineIndex) => (
            <div
              key={`${line.type}:${line.oldLineNo ?? "n"}:${line.newLineNo ?? "n"}`}
              className={cn("flex", LINE_TYPE_STYLES[line.type])}
            >
              {/* Gutter */}
              <span
                className={cn(
                  "select-none border-r border-border/30 px-2 text-right",
                  LINE_GUTTER_STYLES[line.type],
                )}
                style={{ minWidth: `${gutterWidth + 2}ch` }}
              >
                {line.oldLineNo ?? line.newLineNo ?? ""}
              </span>

              {/* Prefix */}
              <span
                className={cn("select-none px-1", LINE_GUTTER_STYLES[line.type])}
                aria-hidden="true"
              >
                {LINE_PREFIX[line.type]}
              </span>

              {/* Content */}
              <span className="flex-1 whitespace-pre pr-3">
                <DiffLineContent tokens={tokensByLine?.[lineIndex]} fallback={line.content} />
              </span>
            </div>
          ))}
        </pre>
      </div>

      {diff.lines.length >= MAX_DIFF_LINES && (
        <div
          className={cn(
            CHAT_THREAD_BODY_CLASS,
            "border-t border-border/50 px-3 py-1 text-center font-mono text-muted-foreground/70",
          )}
        >
          Diff truncated
        </div>
      )}
    </div>
  );
});

const DiffLineContent = memo(function DiffLineContent(props: {
  tokens: ThemedToken[] | undefined;
  fallback: string;
}) {
  const { tokens, fallback } = props;
  if (!tokens || tokens.length === 0) {
    return <>{fallback || "\u00A0"}</>;
  }
  return (
    <>
      {tokens.map((token) => (
        <span
          key={`${token.offset}:${token.content.length}`}
          style={token.color ? { color: token.color } : undefined}
        >
          {token.content}
        </span>
      ))}
    </>
  );
});
