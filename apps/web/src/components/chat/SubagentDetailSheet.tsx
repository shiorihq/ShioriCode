import { type ProviderKind, type ThreadId } from "contracts";
import { useQuery } from "@tanstack/react-query";
import { Clock3Icon, Loader2Icon } from "lucide-react";
import { useMemo } from "react";
import { type TimestampFormat } from "contracts/settings";

import { CHAT_THREAD_BODY_CLASS } from "../../chatTypography";
import { type WorkLogEntry } from "../../session-logic";
import { readNativeApi } from "../../nativeApi";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Sheet, SheetPopup } from "../ui/sheet";
import { cn } from "~/lib/utils";
import { formatTimestamp } from "../../timestampFormat";
import { summarizeToolOutput } from "./toolOutput";
import { formatWorkEntry } from "./MessagesTimeline.logic";
import {
  collectSubagentDescendantEntries,
  extractCodexProviderThreadIdsFromWorkEntry,
  extractSubagentResultSummary,
  findSubagentRootEntry,
} from "./subagentDetail";

interface SubagentDetailSheetProps {
  open: boolean;
  onClose: () => void;
  threadId: ThreadId;
  provider: ProviderKind;
  rootItemId: string | null;
  workEntries: ReadonlyArray<WorkLogEntry>;
  markdownCwd: string | undefined;
  timestampFormat: TimestampFormat;
}

function renderActivitySummary(entry: WorkLogEntry): string {
  const formatted = formatWorkEntry(entry);
  return formatted.detail
    ? `${formatted.action} ${formatted.detail}`
    : formatted.action || entry.label;
}

export function SubagentDetailSheet(props: SubagentDetailSheetProps) {
  const rootEntry = useMemo(
    () => findSubagentRootEntry(props.workEntries, props.rootItemId),
    [props.rootItemId, props.workEntries],
  );
  const descendantEntries = useMemo(
    () => collectSubagentDescendantEntries(props.workEntries, props.rootItemId),
    [props.rootItemId, props.workEntries],
  );

  const detailQuery = useQuery({
    enabled: props.open && props.rootItemId !== null,
    queryKey: ["subagent-detail", props.threadId, props.rootItemId],
    queryFn: async () => {
      const api = readNativeApi();
      if (!api || !props.rootItemId) {
        throw new Error("Subagent details are unavailable.");
      }
      return await api.orchestration.getSubagentDetail({
        threadId: props.threadId,
        rootItemId: props.rootItemId,
      });
    },
  });

  const fallbackTitle =
    rootEntry?.detail ??
    rootEntry?.toolTitle ??
    (props.provider === "codex" ? "Codex subagent" : "Claude subagent");
  const fallbackResult = rootEntry ? extractSubagentResultSummary(rootEntry) : null;
  const fallbackProviderThreadIds = rootEntry
    ? extractCodexProviderThreadIdsFromWorkEntry(rootEntry)
    : [];

  const detail = detailQuery.data;
  const title = detail?.title ?? fallbackTitle;
  const resultText = detail?.resultText ?? fallbackResult;
  const providerThreadIds = detail?.providerThreadIds ?? fallbackProviderThreadIds;

  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <SheetPopup side="right" keepMounted className="w-[min(92vw,820px)] max-w-[820px] p-0">
        <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
          <header className="border-b border-border/70 px-5 py-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p
                  className={cn(
                    CHAT_THREAD_BODY_CLASS,
                    "text-muted-foreground uppercase tracking-[0.16em] text-[11px]",
                  )}
                >
                  {props.provider === "codex" ? "Codex Subagent" : "Claude Subagent"}
                </p>
                <h2 className="mt-1 truncate font-medium text-lg">{title}</h2>
                {detail?.description && detail.description !== title && (
                  <p className={cn(CHAT_THREAD_BODY_CLASS, "mt-1 text-muted-foreground")}>
                    {detail.description}
                  </p>
                )}
              </div>
              {detailQuery.isFetching && (
                <Loader2Icon className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="rounded-full border border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground">
                {detail?.mode ?? "unknown"}
              </span>
              {detail?.agentType && (
                <span className="rounded-full border border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground">
                  {detail.agentType}
                </span>
              )}
              {providerThreadIds[0] && (
                <span className="rounded-full border border-border/70 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                  {providerThreadIds[0]}
                </span>
              )}
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {detailQuery.isLoading && (
              <div className="flex h-32 items-center justify-center text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" />
              </div>
            )}

            {detailQuery.isError && (
              <div className="rounded-lg border border-destructive/25 bg-destructive/8 px-4 py-3 text-destructive/85">
                {(detailQuery.error as Error).message}
              </div>
            )}

            {!detailQuery.isLoading && !detailQuery.isError && (
              <div className="space-y-5">
                {detail?.prompt && (
                  <section>
                    <h3 className="mb-2 font-medium text-sm">Prompt</h3>
                    <div className="rounded-lg border border-border/70 bg-muted/20 px-4 py-3">
                      <ChatMarkdown
                        text={detail.prompt}
                        cwd={props.markdownCwd}
                        className={CHAT_THREAD_BODY_CLASS}
                      />
                    </div>
                  </section>
                )}

                {detail?.transcript && detail.transcript.length > 0 && (
                  <section>
                    <h3 className="mb-2 font-medium text-sm">Transcript</h3>
                    <div className="space-y-3">
                      {detail.transcript.map((entry) => (
                        <article
                          key={entry.id}
                          className="rounded-lg border border-border/70 bg-card/60 px-4 py-3"
                        >
                          <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground uppercase tracking-[0.14em]">
                            <span>{entry.role}</span>
                            {entry.createdAt && (
                              <>
                                <span>•</span>
                                <span>
                                  {formatTimestamp(entry.createdAt, props.timestampFormat)}
                                </span>
                              </>
                            )}
                          </div>
                          <ChatMarkdown
                            text={entry.text}
                            cwd={props.markdownCwd}
                            className={CHAT_THREAD_BODY_CLASS}
                          />
                        </article>
                      ))}
                    </div>
                  </section>
                )}

                {resultText && (
                  <section>
                    <h3 className="mb-2 font-medium text-sm">Result</h3>
                    <div className="rounded-lg border border-border/70 bg-card/60 px-4 py-3">
                      <ChatMarkdown
                        text={resultText}
                        cwd={props.markdownCwd}
                        className={CHAT_THREAD_BODY_CLASS}
                      />
                    </div>
                  </section>
                )}

                {detail?.outputText && (
                  <section>
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <h3 className="font-medium text-sm">Background Output</h3>
                      {detail.outputTextTruncated && (
                        <span className="text-[11px] text-muted-foreground">Preview truncated</span>
                      )}
                    </div>
                    <div className="rounded-lg border border-border/70 bg-card/60 px-4 py-3">
                      <pre
                        className={cn(
                          CHAT_THREAD_BODY_CLASS,
                          "overflow-x-auto whitespace-pre-wrap text-foreground/80",
                        )}
                      >
                        {detail.outputText}
                      </pre>
                    </div>
                  </section>
                )}

                {descendantEntries.length > 0 && (
                  <section>
                    <h3 className="mb-2 font-medium text-sm">Activity</h3>
                    <div className="space-y-3">
                      {descendantEntries.map((entry) => {
                        const outputSummary = summarizeToolOutput(entry.output);
                        return (
                          <article
                            key={entry.id}
                            className="rounded-lg border border-border/70 bg-card/50 px-4 py-3"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <p className={cn(CHAT_THREAD_BODY_CLASS, "text-foreground/85")}>
                                {renderActivitySummary(entry)}
                              </p>
                              <div className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                                <Clock3Icon className="size-3.5" />
                                <span>
                                  {formatTimestamp(entry.createdAt, props.timestampFormat)}
                                </span>
                              </div>
                            </div>
                            {outputSummary.text && (
                              <pre
                                className={cn(
                                  CHAT_THREAD_BODY_CLASS,
                                  "mt-2 overflow-x-auto whitespace-pre-wrap text-foreground/60",
                                )}
                              >
                                {outputSummary.text}
                              </pre>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  </section>
                )}

                {!detail?.transcript?.length &&
                  !resultText &&
                  !detail?.outputText &&
                  descendantEntries.length === 0 && (
                    <div className="rounded-lg border border-border/70 bg-muted/20 px-4 py-3 text-muted-foreground">
                      No subagent content is available yet.
                    </div>
                  )}
              </div>
            )}
          </div>

          <div className="border-t border-border/70 px-5 py-3">
            <Button type="button" variant="ghost" size="sm" onClick={props.onClose}>
              Close
            </Button>
          </div>
        </div>
      </SheetPopup>
    </Sheet>
  );
}
