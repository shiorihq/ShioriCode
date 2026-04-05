import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, LazyMotion, domAnimation, m, useReducedMotion } from "framer-motion";
import { ArrowUpRightIcon } from "lucide-react";

import { ShioriIcon } from "../Icons";

const GREETINGS = [
  "What would you like to build?",
  "What are you working on?",
  "What can I help you ship?",
  "What's on your mind?",
  "Ready when you are.",
] as const;

const CYCLE_MS = 4000;

const SUGGESTIONS = [
  { label: "Review code", prompt: "Review the recent changes and suggest improvements" },
  { label: "Fix a bug", prompt: "Help me fix a bug: " },
  { label: "Write tests", prompt: "Write tests for " },
  { label: "Refactor", prompt: "Refactor " },
] as const;

const EASE = [0.4, 0, 0.2, 1] as const;

/** Icon + rotating greeting text, rendered above the composer. */
export function EmptyThreadHeading() {
  const shouldReduceMotion = useReducedMotion();
  const [greetingIndex, setGreetingIndex] = useState(() =>
    Math.floor(Math.random() * GREETINGS.length),
  );

  useEffect(() => {
    const id = setInterval(() => {
      setGreetingIndex((prev) => (prev + 1) % GREETINGS.length);
    }, CYCLE_MS);
    return () => clearInterval(id);
  }, []);

  const skip = !!shouldReduceMotion;

  return (
    <LazyMotion features={domAnimation}>
      <m.div
        className="mb-6 flex flex-col items-center text-center"
        initial={skip ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.01 }}
      >
        {/* Icon */}
        <m.div
          className="mb-5 flex size-14 items-center justify-center rounded-2xl border border-border/60 bg-card/80 text-foreground/20 shadow-sm"
          initial={skip ? false : { opacity: 0, scale: 0.85 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.45, ease: EASE }}
        >
          <ShioriIcon className="size-7" />
        </m.div>

        {/* Rotating greeting */}
        <m.div
          className="relative h-8 overflow-hidden"
          initial={skip ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.12, ease: EASE }}
        >
          <AnimatePresence mode="wait">
            <m.h2
              key={greetingIndex}
              className="text-xl font-medium tracking-tight text-foreground/85"
              {...(skip
                ? { initial: false as const }
                : {
                    initial: { opacity: 0, y: 8, filter: "blur(2px)" },
                    animate: { opacity: 1, y: 0, filter: "blur(0px)" },
                    exit: { opacity: 0, y: -8, filter: "blur(2px)" },
                  })}
              transition={{ duration: 0.3, ease: EASE }}
            >
              {GREETINGS[greetingIndex]}
            </m.h2>
          </AnimatePresence>
        </m.div>

        {/* Subtitle */}
        <m.p
          className="mt-1 text-[13px] text-muted-foreground/45"
          initial={skip ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, delay: 0.24, ease: EASE }}
        >
          Describe a task, or pick a starting point below.
        </m.p>
      </m.div>
    </LazyMotion>
  );
}

type EmptyThreadSuggestionsProps = {
  onSuggestion: (prompt: string) => void;
};

/** Suggestion links rendered beneath the composer. */
export function EmptyThreadSuggestions({ onSuggestion }: EmptyThreadSuggestionsProps) {
  const shouldReduceMotion = useReducedMotion();
  const skip = !!shouldReduceMotion;

  const handleClick = useCallback(
    (prompt: string) => {
      onSuggestion(prompt);
    },
    [onSuggestion],
  );

  return (
    <LazyMotion features={domAnimation}>
      <m.div
        className="mx-auto mt-3 flex w-full max-w-[52rem] flex-wrap items-center justify-center gap-x-1 gap-y-0"
        initial={skip ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.32, ease: EASE }}
      >
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => handleClick(s.prompt)}
            className="group flex items-center gap-1 rounded-md px-2 py-1 text-[12.5px] text-muted-foreground/50 transition-colors duration-150 hover:text-foreground/70"
          >
            <span>{s.label}</span>
            <ArrowUpRightIcon className="size-3 -translate-x-0.5 rotate-12 opacity-0 transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-100" />
          </button>
        ))}
      </m.div>
    </LazyMotion>
  );
}
