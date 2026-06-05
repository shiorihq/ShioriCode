import {
  CODEX_REASONING_EFFORT_OPTIONS,
  DEFAULT_MODEL_BY_PROVIDER,
  ModelSelection,
  type CodexModelOptions,
  type CodexReasoningEffort,
  type ModelSelection as ModelSelectionValue,
} from "contracts";
import { Schema } from "effect";

const decodeModelSelection = Schema.decodeUnknownSync(ModelSelection);

const FALLBACK_MODEL_SELECTION: ModelSelectionValue = {
  provider: "codex",
  model: DEFAULT_MODEL_BY_PROVIDER.codex,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCodexReasoningEffort(value: string): value is CodexReasoningEffort {
  return CODEX_REASONING_EFFORT_OPTIONS.some((option) => option === value);
}

function normalizeLegacyShioriModel(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_MODEL_BY_PROVIDER.codex;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return DEFAULT_MODEL_BY_PROVIDER.codex;
  }

  return trimmed.startsWith("openai/") ? trimmed.slice("openai/".length) : trimmed;
}

function normalizeLegacyShioriOptions(value: unknown): CodexModelOptions | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const reasoningEffort = value.reasoningEffort;
  if (typeof reasoningEffort === "string" && isCodexReasoningEffort(reasoningEffort)) {
    return { reasoningEffort };
  }

  return undefined;
}

function normalizeLegacyModelSelection(value: unknown): unknown {
  if (!isRecord(value) || value.provider !== "shiori") {
    return value;
  }

  const options = normalizeLegacyShioriOptions(value.options);
  return {
    provider: "codex",
    model: normalizeLegacyShioriModel(value.model),
    ...(options !== undefined ? { options } : {}),
  };
}

export function decodeStoredModelSelectionJson(value: string | null): ModelSelectionValue {
  if (value === null) {
    return FALLBACK_MODEL_SELECTION;
  }

  try {
    return decodeModelSelection(normalizeLegacyModelSelection(JSON.parse(value)));
  } catch {
    return FALLBACK_MODEL_SELECTION;
  }
}

export function decodeStoredNullableModelSelectionJson(
  value: string | null,
): ModelSelectionValue | null {
  if (value === null) {
    return null;
  }

  try {
    return decodeModelSelection(normalizeLegacyModelSelection(JSON.parse(value)));
  } catch {
    return FALLBACK_MODEL_SELECTION;
  }
}
