import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";
import type { ProviderKind } from "./orchestration";

export const CODEX_REASONING_EFFORT_OPTIONS = ["xhigh", "high", "medium", "low"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_OPTIONS)[number];
export const CLAUDE_CODE_EFFORT_OPTIONS = ["low", "medium", "high", "max", "ultrathink"] as const;
export type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORT_OPTIONS)[number];
export const GLM_CODE_EFFORT_OPTIONS = ["low", "medium", "high", "max"] as const;
export type GlmCodeEffort = (typeof GLM_CODE_EFFORT_OPTIONS)[number];
export type ProviderReasoningEffort = CodexReasoningEffort | ClaudeCodeEffort | GlmCodeEffort;

export const CodexModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
});
export type CodexModelOptions = typeof CodexModelOptions.Type;

export const KimiCodeModelOptions = Schema.Struct({
  thinking: Schema.optional(Schema.Boolean),
});
export type KimiCodeModelOptions = typeof KimiCodeModelOptions.Type;

export const GeminiModelOptions = Schema.Struct({});
export type GeminiModelOptions = typeof GeminiModelOptions.Type;

export const GlmModelOptions = Schema.Struct({
  effort: Schema.optional(Schema.Literals(GLM_CODE_EFFORT_OPTIONS)),
  contextWindow: Schema.optional(Schema.String),
});
export type GlmModelOptions = typeof GlmModelOptions.Type;

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
  kimiCode: Schema.optional(KimiCodeModelOptions),
  gemini: Schema.optional(GeminiModelOptions),
  glm: Schema.optional(GlmModelOptions),
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
  kimiCode: "kimi2.7-code",
  gemini: "auto",
  glm: "glm-5.2",
  cursor: "auto",
  codex: "gpt-5.5",
  claudeAgent: "claude-sonnet-5",
};

export const DEFAULT_MODEL = DEFAULT_MODEL_BY_PROVIDER.codex;

/** Per-provider text generation model defaults. */
export const DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER: Record<ProviderKind, string> = {
  kimiCode: "kimi2.7-code",
  gemini: "auto",
  glm: "glm-5.2",
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
  kimiCode: {
    kimi: "kimi2.7-code",
    "kimi-code": "kimi2.7-code",
    "kimi2.7": "kimi2.7-code",
    "kimi2.7-code": "kimi2.7-code",
    "kimi-2.7": "kimi2.7-code",
    "kimi-2.7-code": "kimi2.7-code",
    "kimi-k2.7": "kimi2.7-code",
    "kimi-k2.6": "kimi2.7-code",
    "kimi-for-coding": "kimi2.7-code",
    "kimi-code/kimi-for-coding": "kimi2.7-code",
    latest: "kimi2.7-code",
  },
  gemini: {
    gemini: "auto",
    auto: "auto",
    latest: "auto",
  },
  glm: {
    glm: "glm-5.2",
    "glm-5.2": "glm-5.2",
    "5.2": "glm-5.2",
    "glm-code": "glm-5.2",
    "glm-coding-plan": "glm-5.2",
    "glm-turbo": "glm-5-turbo",
    "glm-5-turbo": "glm-5-turbo",
    "5-turbo": "glm-5-turbo",
    turbo: "glm-5-turbo",
    "glm-4.7": "glm-4.7",
    "4.7": "glm-4.7",
    zai: "glm-5.2",
    "z-ai": "glm-5.2",
    latest: "glm-5.2",
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
    default: "claude-sonnet-5",
    opus: "claude-opus-4-8",
    "opus-4.8": "claude-opus-4-8",
    "claude-opus-4.8": "claude-opus-4-8",
    "opus-4.7": "claude-opus-4-7",
    "claude-opus-4.7": "claude-opus-4-7",
    "opus-4.6": "claude-opus-4-6",
    "claude-opus-4.6": "claude-opus-4-6",
    "claude-opus-4-6-20251117": "claude-opus-4-6",
    sonnet: "claude-sonnet-5",
    "sonnet-5": "claude-sonnet-5",
    "claude-sonnet-5": "claude-sonnet-5",
    "sonnet-5.0": "claude-sonnet-5",
    // Legacy alias: Sonnet 4.6 was replaced by Sonnet 5; redirect old selections forward.
    "sonnet-4.6": "claude-sonnet-5",
    "claude-sonnet-4.6": "claude-sonnet-5",
    "claude-sonnet-4-6": "claude-sonnet-5",
    "claude-sonnet-4-6-20251117": "claude-sonnet-5",
    haiku: "claude-haiku-4-5",
    "haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  },
};

// ── Provider display names ────────────────────────────────────────────

export const PROVIDER_DISPLAY_NAMES: Record<ProviderKind, string> = {
  kimiCode: "Kimi Code",
  gemini: "Antigravity",
  glm: "GLM",
  cursor: "Cursor",
  codex: "Codex",
  claudeAgent: "Claude",
};
