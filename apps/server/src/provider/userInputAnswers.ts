import type { ProviderUserInputAnswers, UserInputQuestion } from "contracts";

function normalizedAnswerValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(value)) {
    const joined = value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0)
      .join(", ");
    return joined.length > 0 ? joined : undefined;
  }

  if (value && typeof value === "object") {
    const answerList = (value as { readonly answers?: unknown }).answers;
    return normalizedAnswerValue(answerList);
  }

  return undefined;
}

export function normalizeUserInputAnswersByQuestionText(
  questions: ReadonlyArray<UserInputQuestion>,
  answers: ProviderUserInputAnswers,
): Record<string, string> {
  const normalizedAnswers: Record<string, string> = {};

  for (const question of questions) {
    const rawAnswer =
      answers[question.id] !== undefined
        ? answers[question.id]
        : answers[question.question] !== undefined
          ? answers[question.question]
          : answers[question.header];
    const answer = normalizedAnswerValue(rawAnswer);
    if (answer) {
      normalizedAnswers[question.question] = answer;
    }
  }

  return normalizedAnswers;
}
