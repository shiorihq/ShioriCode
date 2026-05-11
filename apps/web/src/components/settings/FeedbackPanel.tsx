import {
  IconCircleCheckOutline24 as CheckCircleIcon,
  IconCircleDottedOutline24 as CircleIcon,
  IconClockOutline24 as ClockIcon,
  IconMessageOutline24 as MessageSquareIcon,
  IconTriangleWarningOutline24 as TriangleAlertIcon,
} from "nucleo-core-outline-24";
import { type IconLike } from "../Icons";
import { useCallback, useState } from "react";
import { useMutation, useQuery } from "convex/react";

import {
  hostedTicketCreateMutation,
  hostedTicketListQuery,
  type HostedTicket,
} from "../../convex/api";
import { useHostedShioriState } from "../../convex/HostedShioriProvider";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { LoadingText } from "../ui/loading-text";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

const SHIORICODE_PREFIX = "[ShioriCode]";

const TOPICS = ["Bug Report", "Feature Request", "General Question", "Other"] as const;

const STATUS_CONFIG: Record<
  HostedTicket["status"],
  {
    icon: IconLike;
    color: string;
    label: string;
    variant: "default" | "secondary" | "outline" | "info" | "success";
  }
> = {
  open: { icon: CircleIcon, color: "text-blue-500", label: "Open", variant: "info" },
  in_progress: {
    icon: ClockIcon,
    color: "text-yellow-500",
    label: "In Progress",
    variant: "secondary",
  },
  resolved: {
    icon: CheckCircleIcon,
    color: "text-green-500",
    label: "Resolved",
    variant: "success",
  },
  closed: {
    icon: TriangleAlertIcon,
    color: "text-muted-foreground",
    label: "Closed",
    variant: "outline",
  },
};

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function TicketCard({ ticket }: { ticket: HostedTicket }) {
  const config = STATUS_CONFIG[ticket.status];
  const StatusIcon = config.icon;
  const displayTopic = ticket.topic.replace(`${SHIORICODE_PREFIX} `, "");

  return (
    <div className="border-t border-border px-4 py-3.5 first:border-t-0 sm:px-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" size="sm">
              {displayTopic}
            </Badge>
            <Badge variant={config.variant} size="sm">
              <StatusIcon className={`size-3 ${config.color}`} />
              {config.label}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground line-clamp-2">{ticket.message}</p>
        </div>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {formatDate(ticket.createdAt)}
        </span>
      </div>
      {ticket.adminNotes ? (
        <div className="mt-2.5 rounded-lg bg-muted/50 px-3 py-2">
          <p className="text-[11px] font-medium text-muted-foreground">Response</p>
          <p className="mt-0.5 text-xs text-foreground">{ticket.adminNotes}</p>
        </div>
      ) : null}
    </div>
  );
}

export function FeedbackPanel() {
  const { isAuthenticated, isAuthLoading } = useHostedShioriState();
  const tickets = useQuery(hostedTicketListQuery, isAuthenticated ? {} : "skip");
  const createTicket = useMutation(hostedTicketCreateMutation);

  const [selectedTopic, setSelectedTopic] = useState<string>("");
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canSubmit = selectedTopic.length > 0 && message.trim().length > 0 && !isSubmitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;

    setIsSubmitting(true);
    try {
      await createTicket({
        topic: `${SHIORICODE_PREFIX} ${selectedTopic}`,
        message: message.trim(),
      });
      setSelectedTopic("");
      setMessage("");
      toastManager.add({ type: "success", title: "Ticket submitted. We'll get back to you soon." });
    } catch {
      toastManager.add({ type: "error", title: "Failed to submit ticket. Please try again." });
    } finally {
      setIsSubmitting(false);
    }
  }, [canSubmit, createTicket, message, selectedTopic]);

  // Filter to only show tickets from ShioriCode
  const shioricodeTickets = tickets?.filter((t) => t.topic.startsWith(SHIORICODE_PREFIX)) ?? [];

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        {/* Submit feedback */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <MessageSquareIcon className="size-3.5" />
              Send Feedback
            </h2>
          </div>
          <div className="relative overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-xs/5 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]">
            {!isAuthenticated && !isAuthLoading ? (
              <div className="px-4 py-8 text-center sm:px-5">
                <p className="text-sm text-muted-foreground">
                  Sign in with your Shiori account to send feedback.
                </p>
              </div>
            ) : (
              <div className="space-y-4 px-4 py-4 sm:px-5">
                <div className="space-y-2">
                  <Label htmlFor="feedback-topic">Topic</Label>
                  <Select
                    value={selectedTopic}
                    onValueChange={(value) => {
                      if (value) setSelectedTopic(value);
                    }}
                    disabled={isSubmitting}
                  >
                    <SelectTrigger size="default">
                      <SelectValue placeholder="Select a topic" />
                    </SelectTrigger>
                    <SelectPopup>
                      {TOPICS.map((topic) => (
                        <SelectItem key={topic} value={topic}>
                          {topic}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="feedback-message">Message</Label>
                  <Textarea
                    id="feedback-message"
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder="Describe your issue, suggestion, or question..."
                    disabled={isSubmitting}
                  />
                </div>
                <div className="flex justify-end">
                  <Button size="sm" disabled={!canSubmit} onClick={() => void handleSubmit()}>
                    {isSubmitting ? <LoadingText>Submitting</LoadingText> : "Submit Ticket"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Ticket history */}
        {shioricodeTickets.length > 0 ? (
          <section className="space-y-3">
            <h2 className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              Your Tickets
            </h2>
            <div className="relative overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-xs/5 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]">
              {shioricodeTickets.map((ticket) => (
                <TicketCard key={ticket._id} ticket={ticket} />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
