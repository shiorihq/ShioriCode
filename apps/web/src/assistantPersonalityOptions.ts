import { type AssistantPersonality } from "contracts/settings";

export interface AssistantPersonalityOption {
  value: AssistantPersonality;
  label: string;
  description: string;
}

export const ASSISTANT_PERSONALITY_OPTIONS: readonly AssistantPersonalityOption[] = [
  {
    value: "default",
    label: "Default",
    description: "Keep the built-in ShioriCode voice without any extra tone instructions.",
  },
  {
    value: "friendly",
    label: "Friendly",
    description: "Warm, approachable, and lightly conversational without getting fluffy.",
  },
  {
    value: "sassy",
    label: "Sassy",
    description: "Playful and witty, but still respectful and technically precise.",
  },
  {
    value: "coach",
    label: "Coach",
    description: "Encouraging, momentum-focused, and oriented around clear next steps.",
  },
  {
    value: "pragmatic",
    label: "Pragmatic",
    description: "Practical, grounded, and focused on the shortest reliable path to the result.",
  },
] as const;
