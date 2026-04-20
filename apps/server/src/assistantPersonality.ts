import { DEFAULT_ASSISTANT_PERSONALITY, type AssistantPersonality } from "contracts";

const ASSISTANT_PERSONALITY_APPENDICES: Record<
  Exclude<AssistantPersonality, "default">,
  ReadonlyArray<string>
> = {
  friendly: [
    "Sound warm, approachable, and lightly conversational.",
    "Use a little warmth and occasional light humor, but keep answers concise and useful.",
    "Do not pad technical answers with excessive reassurance or filler.",
  ],
  sassy: [
    "Sound playful, confident, and a little witty.",
    "Use light sass only when it sharpens the reply; never be rude, dismissive, or mean.",
    "Aim any sharpness at the situation or code, never at the user.",
  ],
  coach: [
    "Sound encouraging, focused, and momentum-oriented.",
    "Frame guidance around concrete next steps and progress.",
    "Keep the tone motivating without becoming vague, soft, or repetitive.",
  ],
  pragmatic: [
    "Sound practical, grounded, and outcome-focused.",
    "Prioritize clear tradeoffs, direct recommendations, and efficient execution.",
    "Avoid theatrics, fluff, and unnecessary caveats when the right path is clear.",
  ],
};

export function buildAssistantPersonalityAppendix(
  personality: AssistantPersonality | null | undefined,
): string | undefined {
  const resolved = personality ?? DEFAULT_ASSISTANT_PERSONALITY;
  if (resolved === "default") {
    return undefined;
  }

  return [
    "## Personality Overlay",
    "Apply this as a light tone overlay on top of every other instruction in this prompt.",
    "Never let tone reduce honesty, correctness, safety, or clarity.",
    ...ASSISTANT_PERSONALITY_APPENDICES[resolved],
  ].join("\n");
}

export function buildMemoryGenerationAppendix(
  generateMemories: boolean | null | undefined,
): string | undefined {
  if (generateMemories === false) {
    return undefined;
  }

  return [
    "## Memories",
    "If your runtime supports durable memories or preference capture, keep them updated with stable, reusable facts that will help in future turns.",
    "Only record enduring preferences, project conventions, or long-lived context.",
    "Never store secrets, credentials, tokens, or other sensitive values as memories.",
    "Ignore this section when no memory mechanism is available in the current runtime.",
  ].join("\n");
}

export function buildAssistantSettingsAppendix(input: {
  personality: AssistantPersonality | null | undefined;
  generateMemories: boolean | null | undefined;
}): string | undefined {
  const appendices = [
    buildAssistantPersonalityAppendix(input.personality),
    buildMemoryGenerationAppendix(input.generateMemories),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  return appendices.length > 0 ? appendices.join("\n\n") : undefined;
}

export function appendPromptAppendix(base: string, appendix: string | undefined): string {
  return appendix ? `${base}\n\n${appendix}` : base;
}
