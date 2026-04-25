import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";
import type { ProviderKind } from "./orchestration";

export const CODEX_REASONING_EFFORT_OPTIONS = ["xhigh", "high", "medium", "low"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_OPTIONS)[number];
export const SHIORI_REASONING_EFFORT_OPTIONS = ["low", "medium", "high"] as const;
export type ShioriReasoningEffort = (typeof SHIORI_REASONING_EFFORT_OPTIONS)[number];
export const CLAUDE_CODE_EFFORT_OPTIONS = ["low", "medium", "high", "max", "ultrathink"] as const;
export type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORT_OPTIONS)[number];
export type ProviderReasoningEffort =
  | CodexReasoningEffort
  | ShioriReasoningEffort
  | ClaudeCodeEffort;

export const CodexModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
});
export type CodexModelOptions = typeof CodexModelOptions.Type;

export const ShioriModelOptions = Schema.Struct({
  thinking: Schema.optional(Schema.Boolean),
  reasoningEffort: Schema.optional(Schema.Literals(SHIORI_REASONING_EFFORT_OPTIONS)),
});
export type ShioriModelOptions = typeof ShioriModelOptions.Type;

export const KimiCodeModelOptions = Schema.Struct({
  thinking: Schema.optional(Schema.Boolean),
});
export type KimiCodeModelOptions = typeof KimiCodeModelOptions.Type;

export const GeminiModelOptions = Schema.Struct({});
export type GeminiModelOptions = typeof GeminiModelOptions.Type;

export const CursorModelOptions = Schema.Struct({
  thinking: Schema.optional(Schema.Boolean),
  reasoning: Schema.optional(Schema.String),
  contextWindow: Schema.optional(Schema.String),
  fastMode: Schema.optional(Schema.Boolean),
});
export type CursorModelOptions = typeof CursorModelOptions.Type;

export const ClaudeModelOptions = Schema.Struct({
  thinking: Schema.optional(Schema.Boolean),
  effort: Schema.optional(Schema.Literals(CLAUDE_CODE_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
  contextWindow: Schema.optional(Schema.String),
});
export type ClaudeModelOptions = typeof ClaudeModelOptions.Type;

export const ProviderModelOptions = Schema.Struct({
  shiori: Schema.optional(ShioriModelOptions),
  kimiCode: Schema.optional(KimiCodeModelOptions),
  gemini: Schema.optional(GeminiModelOptions),
  cursor: Schema.optional(CursorModelOptions),
  codex: Schema.optional(CodexModelOptions),
  claudeAgent: Schema.optional(ClaudeModelOptions),
});
export type ProviderModelOptions = typeof ProviderModelOptions.Type;

export const EffortOption = Schema.Struct({
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  isDefault: Schema.optional(Schema.Boolean),
});
export type EffortOption = typeof EffortOption.Type;

export const ContextWindowOption = Schema.Struct({
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  isDefault: Schema.optional(Schema.Boolean),
});
export type ContextWindowOption = typeof ContextWindowOption.Type;

export const ModelCapabilities = Schema.Struct({
  reasoningEffortLevels: Schema.Array(EffortOption),
  supportsFastMode: Schema.Boolean,
  supportsThinkingToggle: Schema.Boolean,
  contextWindowOptions: Schema.Array(ContextWindowOption),
  promptInjectedEffortLevels: Schema.Array(TrimmedNonEmptyString),
});
export type ModelCapabilities = typeof ModelCapabilities.Type;

export const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderKind, string> = {
  shiori: "openai/gpt-5.4",
  kimiCode: "kimi-code/kimi-for-coding",
  gemini: "auto",
  cursor: "auto",
  codex: "gpt-5.5",
  claudeAgent: "claude-sonnet-4-6",
};

export const DEFAULT_MODEL = DEFAULT_MODEL_BY_PROVIDER.codex;

/** Per-provider text generation model defaults. */
export const DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER: Record<ProviderKind, string> = {
  shiori: "openai/gpt-5.4-mini",
  kimiCode: "kimi-code/kimi-for-coding",
  gemini: "auto",
  cursor: "auto",
  codex: "gpt-5.4-mini",
  claudeAgent: "claude-haiku-4-5",
};

export const TEXT_GENERATION_PROVIDER_KINDS = [
  "codex",
  "claudeAgent",
] as const satisfies readonly ProviderKind[];
export type TextGenerationProviderKind = (typeof TEXT_GENERATION_PROVIDER_KINDS)[number];

export const MODEL_SLUG_ALIASES_BY_PROVIDER: Record<ProviderKind, Record<string, string>> = {
  shiori: {
    "5.4": "openai/gpt-5.4",
    "gpt-5.4": "openai/gpt-5.4",
    "5.4-mini": "openai/gpt-5.4-mini",
    "gpt-5.4-mini": "openai/gpt-5.4-mini",
    "claude-sonnet": "anthropic/claude-sonnet-4-5",
    "claude-sonnet-4.5": "anthropic/claude-sonnet-4-5",
    "claude-sonnet-4-5": "anthropic/claude-sonnet-4-5",
    "anthropic/claude-sonnet-4.5": "anthropic/claude-sonnet-4-5",
    "gemini-flash": "google/gemini-2.5-flash",
    qwen: "qwen/qwen3.5-plus-02-15",
    "qwen3.5-plus": "qwen/qwen3.5-plus-02-15",
    "qwen-3.5-plus": "qwen/qwen3.5-plus-02-15",
    "qwen3.5-plus-thinking": "qwen/qwen3.5-plus-02-15",
    "qwen-3.5-plus-thinking": "qwen/qwen3.5-plus-02-15",
  },
  kimiCode: {
    kimi: "kimi-code/kimi-for-coding",
    "kimi-code": "kimi-code/kimi-for-coding",
    "kimi-k2.6": "kimi-code/kimi-for-coding",
    "kimi-for-coding": "kimi-code/kimi-for-coding",
    "kimi-code/kimi-for-coding": "kimi-code/kimi-for-coding",
    latest: "kimi-code/kimi-for-coding",
  },
  gemini: {
    gemini: "auto",
    auto: "auto",
    latest: "auto",
  },
  cursor: {
    cursor: "auto",
    composer: "composer",
    "composer-2": "composer-2",
    auto: "auto",
    default: "auto",
    latest: "auto",
  },
  codex: {
    "5.5": "gpt-5.5",
    "5.4": "gpt-5.4",
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
    "5.3-spark": "gpt-5.3-codex-spark",
    "gpt-5.3-spark": "gpt-5.3-codex-spark",
  },
  claudeAgent: {
    opus: "claude-opus-4-7",
    "opus-4.7": "claude-opus-4-7",
    "claude-opus-4.7": "claude-opus-4-7",
    "opus-4.6": "claude-opus-4-6",
    "claude-opus-4.6": "claude-opus-4-6",
    "claude-opus-4-6-20251117": "claude-opus-4-6",
    sonnet: "claude-sonnet-4-6",
    "sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4-6-20251117": "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5",
    "haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  },
};

// ── Provider display names ────────────────────────────────────────────

export const PROVIDER_DISPLAY_NAMES: Record<ProviderKind, string> = {
  shiori: "Shiori",
  kimiCode: "Kimi Code",
  gemini: "Gemini",
  cursor: "Cursor",
  codex: "Codex",
  claudeAgent: "Claude",
};
