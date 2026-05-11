import { type ApprovalRequestId } from "contracts";
import { memo, useCallback, useEffect, useRef } from "react";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { IconCheckOutline24 as CheckIcon } from "nucleo-core-outline-24";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Kbd } from "../ui/kbd";

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  respondingRequestIds: ApprovalRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onSelectOption: (questionId: string, optionLabel: string) => void;
  onAdvance: () => void;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  respondingRequestIds,
  answers,
  questionIndex,
  onSelectOption,
  onAdvance,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      questionIndex={questionIndex}
      onSelectOption={onSelectOption}
      onAdvance={onAdvance}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  isResponding,
  answers,
  questionIndex,
  onSelectOption,
  onAdvance,
}: {
  prompt: PendingUserInput;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onSelectOption: (questionId: string, optionLabel: string) => void;
  onAdvance: () => void;
}) {
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const autoAdvanceTimerRef = useRef<number | null>(null);

  // Clear auto-advance timer on unmount
  useEffect(() => {
    return () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
      }
    };
  }, []);

  const selectOptionAndAutoAdvance = useCallback(
    (questionId: string, optionLabel: string) => {
      onSelectOption(questionId, optionLabel);
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
      }
      autoAdvanceTimerRef.current = window.setTimeout(() => {
        autoAdvanceTimerRef.current = null;
        onAdvance();
      }, 200);
    },
    [onSelectOption, onAdvance],
  );

  // Keyboard shortcut: number keys 1-9 select corresponding option and auto-advance.
  // Works even when the Lexical composer (contenteditable) has focus — the composer
  // doubles as a custom-answer field during user input, and when it's empty the digit
  // keys should pick options instead of typing into the editor.
  useEffect(() => {
    if (!activeQuestion || isResponding) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      // If the user has started typing a custom answer in the contenteditable
      // composer, let digit keys pass through so they can type numbers.
      if (target instanceof HTMLElement && target.isContentEditable) {
        const hasCustomText = progress.customAnswer.length > 0;
        if (hasCustomText) return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const optionIndex = digit - 1;
      if (optionIndex >= activeQuestion.options.length) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      selectOptionAndAutoAdvance(activeQuestion.id, option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, isResponding, selectOptionAndAutoAdvance, progress.customAnswer.length]);

  if (!activeQuestion) {
    return null;
  }

  return (
    <div className="px-4 py-3 sm:px-5">
      <div className="flex items-baseline gap-2">
        {prompt.questions.length > 1 ? (
          <Badge variant="secondary" size="sm" className="tabular-nums">
            {questionIndex + 1}/{prompt.questions.length}
          </Badge>
        ) : null}
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {activeQuestion.header}
        </span>
      </div>
      <p className="mt-1 text-sm text-foreground">{activeQuestion.question}</p>
      <div className="mt-2.5 space-y-0.5">
        {activeQuestion.options.map((option, index) => {
          const isSelected = progress.selectedOptionLabel === option.label;
          const shortcutKey = index < 9 ? index + 1 : null;
          return (
            <button
              key={`${activeQuestion.id}:${option.label}`}
              type="button"
              disabled={isResponding}
              onClick={() => selectOptionAndAutoAdvance(activeQuestion.id, option.label)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
                isSelected ? "bg-accent text-foreground" : "text-foreground/80 hover:bg-accent/50",
                isResponding && "cursor-not-allowed opacity-50",
              )}
            >
              {shortcutKey !== null ? (
                <Kbd className={cn(isSelected && "bg-primary/15 text-primary")}>{shortcutKey}</Kbd>
              ) : null}
              <div className="min-w-0 flex-1 truncate">
                <span className="text-sm font-medium">{option.label}</span>
                {option.description && option.description !== option.label ? (
                  <span className="ml-2 text-xs text-muted-foreground">{option.description}</span>
                ) : null}
              </div>
              {isSelected ? <CheckIcon className="size-3.5 shrink-0 text-primary" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
});
