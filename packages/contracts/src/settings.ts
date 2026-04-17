import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas";
import {
  ClaudeModelOptions,
  CodexModelOptions,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  ShioriModelOptions,
} from "./model";
import { OnboardingProgress, OnboardingStepId } from "./onboarding";
import { ModelSelection, ProviderKind } from "./orchestration";

// ── Client Settings (local-only) ───────────────────────────────

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const ThemeMode = Schema.Literals(["system", "light", "dark"]);
export type ThemeMode = typeof ThemeMode.Type;
export const DEFAULT_THEME_MODE: ThemeMode = "system";

export const ThemeAppearance = Schema.Literals(["light", "dark"]);
export type ThemeAppearance = typeof ThemeAppearance.Type;

export const DEFAULT_LIGHT_THEME_ID = "builtin:shioricode-light";
export const DEFAULT_DARK_THEME_ID = "builtin:shioricode-dark";
export const DEFAULT_UI_FONT_FAMILY = "system-ui";
export const DEFAULT_CODE_FONT_FAMILY = "ui-monospace";

export const THEME_TOKEN_KEYS = [
  "background",
  "foreground",
  "card",
  "cardForeground",
  "popover",
  "popoverForeground",
  "primary",
  "primaryForeground",
  "secondary",
  "secondaryForeground",
  "muted",
  "mutedForeground",
  "accent",
  "accentForeground",
  "destructive",
  "destructiveForeground",
  "border",
  "input",
  "ring",
  "info",
  "infoForeground",
  "success",
  "successForeground",
  "warning",
  "warningForeground",
] as const;
export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number];

export const TERMINAL_THEME_COLOR_KEYS = [
  "background",
  "foreground",
  "cursor",
  "selectionBackground",
  "scrollbarSliderBackground",
  "scrollbarSliderHoverBackground",
  "scrollbarSliderActiveBackground",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;
export type TerminalThemeColorKey = (typeof TERMINAL_THEME_COLOR_KEYS)[number];

export const ThemeTokenValues = Schema.Struct({
  background: TrimmedNonEmptyString,
  foreground: TrimmedNonEmptyString,
  card: TrimmedNonEmptyString,
  cardForeground: TrimmedNonEmptyString,
  popover: TrimmedNonEmptyString,
  popoverForeground: TrimmedNonEmptyString,
  primary: TrimmedNonEmptyString,
  primaryForeground: TrimmedNonEmptyString,
  secondary: TrimmedNonEmptyString,
  secondaryForeground: TrimmedNonEmptyString,
  muted: TrimmedNonEmptyString,
  mutedForeground: TrimmedNonEmptyString,
  accent: TrimmedNonEmptyString,
  accentForeground: TrimmedNonEmptyString,
  destructive: TrimmedNonEmptyString,
  destructiveForeground: TrimmedNonEmptyString,
  border: TrimmedNonEmptyString,
  input: TrimmedNonEmptyString,
  ring: TrimmedNonEmptyString,
  info: TrimmedNonEmptyString,
  infoForeground: TrimmedNonEmptyString,
  success: TrimmedNonEmptyString,
  successForeground: TrimmedNonEmptyString,
  warning: TrimmedNonEmptyString,
  warningForeground: TrimmedNonEmptyString,
});
export type ThemeTokenValues = typeof ThemeTokenValues.Type;

export const TerminalThemeColors = Schema.Struct({
  background: TrimmedNonEmptyString,
  foreground: TrimmedNonEmptyString,
  cursor: TrimmedNonEmptyString,
  selectionBackground: TrimmedNonEmptyString,
  scrollbarSliderBackground: TrimmedNonEmptyString,
  scrollbarSliderHoverBackground: TrimmedNonEmptyString,
  scrollbarSliderActiveBackground: TrimmedNonEmptyString,
  black: TrimmedNonEmptyString,
  red: TrimmedNonEmptyString,
  green: TrimmedNonEmptyString,
  yellow: TrimmedNonEmptyString,
  blue: TrimmedNonEmptyString,
  magenta: TrimmedNonEmptyString,
  cyan: TrimmedNonEmptyString,
  white: TrimmedNonEmptyString,
  brightBlack: TrimmedNonEmptyString,
  brightRed: TrimmedNonEmptyString,
  brightGreen: TrimmedNonEmptyString,
  brightYellow: TrimmedNonEmptyString,
  brightBlue: TrimmedNonEmptyString,
  brightMagenta: TrimmedNonEmptyString,
  brightCyan: TrimmedNonEmptyString,
  brightWhite: TrimmedNonEmptyString,
});
export type TerminalThemeColors = typeof TerminalThemeColors.Type;

export const ImportedTheme = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  appearance: ThemeAppearance,
  author: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  description: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  radius: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  tokens: ThemeTokenValues,
  terminal: Schema.optionalKey(TerminalThemeColors),
});
export type ImportedTheme = typeof ImportedTheme.Type;

export const ClientSettingsSchema = Schema.Struct({
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  diffWordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(() => DEFAULT_SIDEBAR_PROJECT_SORT_ORDER),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(() => DEFAULT_SIDEBAR_THREAD_SORT_ORDER),
  ),
  timestampFormat: TimestampFormat.pipe(Schema.withDecodingDefault(() => DEFAULT_TIMESTAMP_FORMAT)),
  themeMode: ThemeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_THEME_MODE)),
  lightThemeId: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(() => DEFAULT_LIGHT_THEME_ID),
  ),
  darkThemeId: TrimmedNonEmptyString.pipe(Schema.withDecodingDefault(() => DEFAULT_DARK_THEME_ID)),
  uiFontFamily: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(() => DEFAULT_UI_FONT_FAMILY),
  ),
  codeFontFamily: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(() => DEFAULT_CODE_FONT_FAMILY),
  ),
  importedThemes: Schema.Array(ImportedTheme).pipe(Schema.withDecodingDefault(() => [])),
  sidebarTranslucent: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

// ── Server Settings (server-authoritative) ────────────────────

export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

export const AssistantPersonality = Schema.Literals([
  "default",
  "friendly",
  "sassy",
  "coach",
  "pragmatic",
]);
export type AssistantPersonality = typeof AssistantPersonality.Type;
export const DEFAULT_ASSISTANT_PERSONALITY: AssistantPersonality = "default";

const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(() => fallback),
  );

export const CodexSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("codex"),
  homePath: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type CodexSettings = typeof CodexSettings.Type;

export const ShioriSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  apiBaseUrl: TrimmedString.pipe(Schema.withDecodingDefault(() => "https://shiori.ai")),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type ShioriSettings = typeof ShioriSettings.Type;

export const ClaudeSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("claude"),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type ClaudeSettings = typeof ClaudeSettings.Type;

// ── MCP Server Configuration ─────────────────────────────────

export const McpTransport = Schema.Literals(["stdio", "sse", "http"]);
export type McpTransport = typeof McpTransport.Type;

export const McpServerEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  transport: McpTransport,
  // sse/http transport fields
  url: Schema.optionalKey(TrimmedString),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  // stdio transport fields
  command: Schema.optionalKey(TrimmedString),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  // Common fields
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  /** Empty array = all providers */
  providers: Schema.Array(ProviderKind).pipe(Schema.withDecodingDefault(() => [])),
});
export type McpServerEntry = typeof McpServerEntry.Type;

export const McpServersConfig = Schema.Struct({
  servers: Schema.Array(McpServerEntry).pipe(Schema.withDecodingDefault(() => [])),
});
export type McpServersConfig = typeof McpServersConfig.Type;

export const EffectiveMcpServerSource = Schema.Literals(["shiori", "codex", "claude"]);
export type EffectiveMcpServerSource = typeof EffectiveMcpServerSource.Type;

export const EffectiveMcpServerAuthStatus = Schema.Literals([
  "unknown",
  "authenticated",
  "unauthenticated",
]);
export type EffectiveMcpServerAuthStatus = typeof EffectiveMcpServerAuthStatus.Type;

export const EffectiveMcpServerAuth = Schema.Struct({
  status: EffectiveMcpServerAuthStatus,
  message: Schema.optionalKey(TrimmedString),
});
export type EffectiveMcpServerAuth = typeof EffectiveMcpServerAuth.Type;

export const EffectiveMcpServerEntry = Schema.Struct({
  ...McpServerEntry.fields,
  source: EffectiveMcpServerSource,
  sourceName: Schema.optionalKey(TrimmedNonEmptyString),
  configPath: Schema.optionalKey(TrimmedNonEmptyString),
  readOnly: Schema.Boolean,
  auth: EffectiveMcpServerAuth,
});
export type EffectiveMcpServerEntry = typeof EffectiveMcpServerEntry.Type;

export const EffectiveMcpServersResult = Schema.Struct({
  servers: Schema.Array(EffectiveMcpServerEntry),
  warnings: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type EffectiveMcpServersResult = typeof EffectiveMcpServersResult.Type;

export const EffectiveSkillSource = Schema.Literals(["shiori", "codex", "claude"]);
export type EffectiveSkillSource = typeof EffectiveSkillSource.Type;

export const EffectiveSkillScope = Schema.Literals(["user", "project"]);
export type EffectiveSkillScope = typeof EffectiveSkillScope.Type;

export const EffectiveSkillEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  source: EffectiveSkillSource,
  scope: EffectiveSkillScope,
  readOnly: Schema.Boolean,
});
export type EffectiveSkillEntry = typeof EffectiveSkillEntry.Type;

export const EffectiveMcpServerRemoveInput = Schema.Struct({
  source: EffectiveMcpServerSource,
  name: TrimmedNonEmptyString,
  sourceName: Schema.optionalKey(TrimmedNonEmptyString),
  configPath: Schema.optionalKey(TrimmedNonEmptyString),
});
export type EffectiveMcpServerRemoveInput = typeof EffectiveMcpServerRemoveInput.Type;

export const EffectiveMcpServerAuthInput = Schema.Struct({
  source: EffectiveMcpServerSource,
  name: TrimmedNonEmptyString,
  sourceName: Schema.optionalKey(TrimmedNonEmptyString),
  configPath: Schema.optionalKey(TrimmedNonEmptyString),
});
export type EffectiveMcpServerAuthInput = typeof EffectiveMcpServerAuthInput.Type;

export const EffectiveSkillRemoveInput = Schema.Struct({
  source: EffectiveSkillSource,
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
});
export type EffectiveSkillRemoveInput = typeof EffectiveSkillRemoveInput.Type;

export const EffectiveSkillsResult = Schema.Struct({
  skills: Schema.Array(EffectiveSkillEntry),
  warnings: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type EffectiveSkillsResult = typeof EffectiveSkillsResult.Type;

export const ServerSettings = Schema.Struct({
  enableAssistantStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  quitWithoutConfirmation: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  assistantPersonality: AssistantPersonality.pipe(
    Schema.withDecodingDefault(() => DEFAULT_ASSISTANT_PERSONALITY),
  ),
  defaultThreadEnvMode: ThreadEnvMode.pipe(
    Schema.withDecodingDefault(() => "local" as const satisfies ThreadEnvMode),
  ),
  defaultModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(() => ({
      provider: "codex" as const,
      model: DEFAULT_MODEL_BY_PROVIDER.codex,
    })),
  ),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(() => ({
      provider: "codex" as const,
      model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
    })),
  ),
  onboarding: OnboardingProgress.pipe(Schema.withDecodingDefault(() => ({}))),

  // MCP servers (global, with per-server provider affinity)
  mcpServers: McpServersConfig.pipe(Schema.withDecodingDefault(() => ({}))),

  // Provider specific settings
  providers: Schema.Struct({
    shiori: ShioriSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    codex: CodexSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    claudeAgent: ClaudeSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  }).pipe(Schema.withDecodingDefault(() => ({}))),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Server settings error at ${this.settingsPath}: ${this.detail}`;
  }
}

// ── Unified type ─────────────────────────────────────────────────────

export type UnifiedSettings = ServerSettings & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

// ── Server Settings Patch (replace with a Schema.deepPartial if available) ──────────────────────────────────────────

const CodexModelOptionsPatch = Schema.Struct({
  reasoningEffort: Schema.optionalKey(CodexModelOptions.fields.reasoningEffort),
  fastMode: Schema.optionalKey(CodexModelOptions.fields.fastMode),
});

const ClaudeModelOptionsPatch = Schema.Struct({
  thinking: Schema.optionalKey(ClaudeModelOptions.fields.thinking),
  effort: Schema.optionalKey(ClaudeModelOptions.fields.effort),
  fastMode: Schema.optionalKey(ClaudeModelOptions.fields.fastMode),
  contextWindow: Schema.optionalKey(ClaudeModelOptions.fields.contextWindow),
});

const ModelSelectionPatch = Schema.Union([
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("shiori")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(ShioriModelOptions),
  }),
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("codex")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(CodexModelOptionsPatch),
  }),
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("claudeAgent")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(ClaudeModelOptionsPatch),
  }),
]);

const ShioriSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  apiBaseUrl: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const CodexSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  homePath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ClaudeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const OnboardingProgressPatch = Schema.Struct({
  completedStepIds: Schema.optionalKey(Schema.Array(OnboardingStepId)),
  dismissed: Schema.optionalKey(Schema.Boolean),
});

export const ServerSettingsPatch = Schema.Struct({
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  quitWithoutConfirmation: Schema.optionalKey(Schema.Boolean),
  assistantPersonality: Schema.optionalKey(AssistantPersonality),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  defaultModelSelection: Schema.optionalKey(ModelSelectionPatch),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  onboarding: Schema.optionalKey(OnboardingProgressPatch),
  mcpServers: Schema.optionalKey(
    Schema.Struct({
      servers: Schema.optionalKey(Schema.Array(McpServerEntry)),
    }),
  ),
  providers: Schema.optionalKey(
    Schema.Struct({
      shiori: Schema.optionalKey(ShioriSettingsPatch),
      codex: Schema.optionalKey(CodexSettingsPatch),
      claudeAgent: Schema.optionalKey(ClaudeSettingsPatch),
    }),
  ),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;
