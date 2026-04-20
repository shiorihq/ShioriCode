interface ToolOutputSummary {
  text: string | null;
  lineCount: number;
  format: "text" | "json";
}

const objectSummaryCache = new WeakMap<object, ToolOutputSummary>();

function countTextLines(text: string): number {
  return Math.max(1, text.split(/\r?\n/g).length);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstNestedContentString(record: Record<string, unknown>): string | null {
  const direct = record.content;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  const fromResult = asRecord(record.result)?.content;
  if (typeof fromResult === "string" && fromResult.length > 0) {
    return fromResult;
  }
  const item = asRecord(record.item);
  if (item) {
    const fromItem = item.content;
    if (typeof fromItem === "string" && fromItem.length > 0) {
      return fromItem;
    }
    const fromItemResult = asRecord(item.result)?.content;
    if (typeof fromItemResult === "string" && fromItemResult.length > 0) {
      return fromItemResult;
    }
  }
  return null;
}

function buildObjectSummary(output: object): ToolOutputSummary {
  const cached = objectSummaryCache.get(output);
  if (cached) {
    return cached;
  }

  const record = output as Record<string, unknown>;
  const nestedContent = firstNestedContentString(record);
  if (nestedContent !== null) {
    const summary = {
      text: nestedContent,
      lineCount: countTextLines(nestedContent),
      format: "text",
    } satisfies ToolOutputSummary;
    objectSummaryCache.set(output, summary);
    return summary;
  }

  if ("entries" in record && Array.isArray(record.entries)) {
    const entries = record.entries as Array<{ name?: string; kind?: string }>;
    const text =
      entries.length === 0
        ? "(empty directory)"
        : entries
            .map((entry) => {
              const suffix = entry.kind === "directory" ? "/" : "";
              return `${entry.name ?? "?"}${suffix}`;
            })
            .join("\n");
    const summary = {
      text,
      lineCount: countTextLines(text),
      format: "text",
    } satisfies ToolOutputSummary;
    objectSummaryCache.set(output, summary);
    return summary;
  }

  const stdout = typeof record.stdout === "string" ? record.stdout.trimEnd() : "";
  const stderr = typeof record.stderr === "string" ? record.stderr.trimEnd() : "";
  if (stdout || stderr) {
    const text = stdout && stderr ? `${stdout}\n\n${stderr}` : stdout || stderr;
    const summary = {
      text,
      lineCount: countTextLines(text),
      format: "text",
    } satisfies ToolOutputSummary;
    objectSummaryCache.set(output, summary);
    return summary;
  }

  if (typeof record.bytesWritten === "number" && typeof record.path === "string") {
    const summary = {
      text: `Wrote ${record.bytesWritten} bytes to ${record.path}`,
      lineCount: 1,
      format: "text",
    } satisfies ToolOutputSummary;
    objectSummaryCache.set(output, summary);
    return summary;
  }

  try {
    const text = JSON.stringify(output, null, 2);
    const summary = {
      text: typeof text === "string" ? text : null,
      lineCount: typeof text === "string" ? countTextLines(text) : 1,
      format: "json",
    } satisfies ToolOutputSummary;
    objectSummaryCache.set(output, summary);
    return summary;
  } catch {
    const summary = {
      text: null,
      lineCount: 1,
      format: "text",
    } satisfies ToolOutputSummary;
    objectSummaryCache.set(output, summary);
    return summary;
  }
}

export function summarizeToolOutput(output: unknown): ToolOutputSummary {
  if (output == null) {
    return { text: null, lineCount: 0, format: "text" };
  }

  if (typeof output === "string") {
    return {
      text: output || null,
      lineCount: output.length > 0 ? countTextLines(output) : 0,
      format: "text",
    };
  }

  if (typeof output === "object") {
    return buildObjectSummary(output);
  }

  try {
    const text = JSON.stringify(output, null, 2);
    return {
      text: typeof text === "string" ? text : null,
      lineCount: typeof text === "string" ? countTextLines(text) : 1,
      format: "json",
    };
  } catch {
    return {
      text: null,
      lineCount: 1,
      format: "text",
    };
  }
}
