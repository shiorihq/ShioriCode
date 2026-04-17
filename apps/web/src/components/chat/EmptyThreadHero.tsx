import { useMemo } from "react";
import { LazyMotion, domAnimation, m, useReducedMotion } from "framer-motion";

const EASE = [0.22, 1, 0.36, 1] as const;

const PROJECT_GREETINGS = [
  (name: string) => `Where shall we begin in ${name}?`,
  (name: string) => `What's on the agenda for ${name}?`,
  (name: string) => `Ready to ship something in ${name}?`,
  (name: string) => `What can I help with in ${name}?`,
  (name: string) => `What to improve in ${name}?`,
  (name: string) => `First move in ${name}?`,
  (name: string) => `Pick a thread in ${name}.`,
  (name: string) => `What's next for ${name}?`,
] as const;

const GENERIC_GREETINGS = [
  "Where shall we begin?",
  "What's on your mind?",
  "Ready when you are.",
  "Pick a thread to pull.",
  "What are we building today?",
  "First move?",
  "How can I help?",
  "Let's make something.",
] as const;

function pickGreeting(projectName: string | null | undefined): string {
  const trimmed = projectName?.trim();
  if (trimmed) {
    const pick = PROJECT_GREETINGS[Math.floor(Math.random() * PROJECT_GREETINGS.length)]!;
    return pick(trimmed);
  }
  return GENERIC_GREETINGS[Math.floor(Math.random() * GENERIC_GREETINGS.length)]!;
}

type EmptyThreadHeadingProps = {
  projectName: string | null | undefined;
};

/** Large centered headline shown above the composer on an empty thread. */
export function EmptyThreadHeading({ projectName }: EmptyThreadHeadingProps) {
  const shouldReduceMotion = useReducedMotion();
  const skip = !!shouldReduceMotion;
  const question = useMemo(() => pickGreeting(projectName), [projectName]);

  return (
    <LazyMotion features={domAnimation}>
      <m.h1
        className="px-3 text-center font-semibold tracking-[-0.02em] text-foreground/90 text-[26px] leading-[1.15] sm:text-[32px] md:text-[36px]"
        initial={skip ? false : { opacity: 0, y: 6, filter: "blur(4px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={{ duration: 0.55, ease: EASE }}
      >
        {question}
      </m.h1>
    </LazyMotion>
  );
}
