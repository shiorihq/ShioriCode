import { MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useMemo } from "react";
import { stripInlineTerminalContextPlaceholders } from "../../lib/terminalContext";
import { cn } from "../../lib/utils";
import { type QueuedTurnDraft } from "../../queuedTurnsStore";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

interface QueuedMessagesPanelProps {
  queuedTurns: ReadonlyArray<QueuedTurnDraft>;
  onDeleteQueuedTurn: (queuedTurnId: string) => void;
  onEditQueuedTurn: (queuedTurnId: string) => void;
}

function formatCountLabel(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`;
}

function buildQueuedMessagePreview(queuedTurn: QueuedTurnDraft): string {
  const strippedPrompt = stripInlineTerminalContextPlaceholders(
    queuedTurn.composerSnapshot.prompt,
  ).trim();
  if (strippedPrompt.length > 0) {
    return strippedPrompt;
  }

  const imageCount = queuedTurn.composerSnapshot.persistedAttachments.length;
  const terminalContextCount = queuedTurn.composerSnapshot.terminalContexts.length;
  if (imageCount > 0 && terminalContextCount > 0) {
    return `${formatCountLabel(imageCount, "image", "images")} and ${formatCountLabel(
      terminalContextCount,
      "terminal excerpt",
      "terminal excerpts",
    )}`;
  }
  if (imageCount > 0) {
    return formatCountLabel(imageCount, "image attachment", "image attachments");
  }
  if (terminalContextCount > 0) {
    return formatCountLabel(terminalContextCount, "terminal excerpt", "terminal excerpts");
  }
  return "Queued follow-up";
}

function QueuedMessageRow({
  queuedTurn,
  onDeleteQueuedTurn,
  onEditQueuedTurn,
}: {
  queuedTurn: QueuedTurnDraft;
  onDeleteQueuedTurn: (queuedTurnId: string) => void;
  onEditQueuedTurn: (queuedTurnId: string) => void;
}) {
  const previewText = useMemo(() => buildQueuedMessagePreview(queuedTurn), [queuedTurn]);
  const imageCount = queuedTurn.composerSnapshot.persistedAttachments.length;
  const terminalContextCount = queuedTurn.composerSnapshot.terminalContexts.length;
  const isSending = queuedTurn.status === "sending";

  return (
    <div
      className={cn(
        "group flex items-start justify-between gap-2 rounded-2xl border px-3 py-2.5 shadow-sm",
        queuedTurn.status === "failed"
          ? "border-amber-500/40 bg-amber-500/8"
          : "border-border/60 bg-muted/25",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-sm leading-5 text-foreground/85">{previewText}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span>
            {isSending
              ? "Sending next"
              : queuedTurn.status === "failed"
                ? "Needs attention"
                : "Queued"}
          </span>
          {imageCount > 0 ? <span>{formatCountLabel(imageCount, "image", "images")}</span> : null}
          {terminalContextCount > 0 ? (
            <span>
              {formatCountLabel(terminalContextCount, "terminal excerpt", "terminal excerpts")}
            </span>
          ) : null}
        </div>
        {queuedTurn.status === "failed" && queuedTurn.errorMessage ? (
          <p className="mt-1.5 line-clamp-2 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
            {queuedTurn.errorMessage}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
          aria-label="Delete queued message"
          disabled={isSending}
          onClick={() => onDeleteQueuedTurn(queuedTurn.id)}
        >
          <Trash2Icon className="size-3.5" />
        </Button>

        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                aria-label="Queued message actions"
                disabled={isSending}
              />
            }
          >
            <MoreHorizontalIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="bottom">
            <MenuItem onClick={() => onEditQueuedTurn(queuedTurn.id)}>
              <PencilIcon className="size-4" />
              Edit message
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}

export function QueuedMessagesPanel({
  queuedTurns,
  onDeleteQueuedTurn,
  onEditQueuedTurn,
}: QueuedMessagesPanelProps) {
  if (queuedTurns.length === 0) {
    return null;
  }

  return (
    <div className="rounded-t-[19px] border-b border-border/65 bg-muted/15 px-3 py-2.5 sm:px-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground/80">
            Queue
          </p>
          <p className="text-sm text-foreground/75">
            {formatCountLabel(queuedTurns.length, "message", "messages")} waiting to send
          </p>
        </div>
      </div>
      <div className="space-y-2">
        {queuedTurns.map((queuedTurn) => (
          <QueuedMessageRow
            key={queuedTurn.id}
            queuedTurn={queuedTurn}
            onDeleteQueuedTurn={onDeleteQueuedTurn}
            onEditQueuedTurn={onEditQueuedTurn}
          />
        ))}
      </div>
    </div>
  );
}
