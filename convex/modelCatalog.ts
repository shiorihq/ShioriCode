export interface HostedCatalogModel {
  id: string;
  name: string;
  description: string;
  reasoning: boolean;
  supportsReasoningEffort?: boolean;
  mandatoryReasoning?: boolean;
  reasoningId?: string;
  toolCalling: boolean;
  multiModal: boolean;
  coding?: boolean;
  isEnabled: boolean;
  isPremiumModel: boolean;
  contextWindow: number;
}

export interface HostedCatalogProvider {
  id: string;
  title: string;
  description: string;
  websiteUrl: string;
  sortOrder: number;
  models: HostedCatalogModel[];
}

export const DEFAULT_HOSTED_MODEL_CATALOG: ReadonlyArray<HostedCatalogProvider> = [
  {
    id: "openai",
    title: "OpenAI",
    description: "OpenAI foundation models for coding and reasoning.",
    websiteUrl: "https://openai.com",
    sortOrder: 10,
    models: [
      {
        id: "openai/gpt-5.4",
        name: "GPT-5.4",
        description: "Flagship GPT-5.4 model tuned for strong reasoning and coding.",
        reasoning: true,
        supportsReasoningEffort: true,
        toolCalling: true,
        multiModal: true,
        coding: true,
        isEnabled: true,
        isPremiumModel: true,
        contextWindow: 400_000,
      },
      {
        id: "openai/gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        description: "Lower-latency GPT-5.4 tier for lightweight coding tasks.",
        reasoning: true,
        supportsReasoningEffort: true,
        toolCalling: true,
        multiModal: true,
        coding: true,
        isEnabled: true,
        isPremiumModel: false,
        contextWindow: 400_000,
      },
    ],
  },
  {
    id: "anthropic",
    title: "Anthropic",
    description: "Claude models optimized for long-form reasoning and code review.",
    websiteUrl: "https://anthropic.com",
    sortOrder: 20,
    models: [
      {
        id: "anthropic/claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        description: "Balanced Claude model for coding, editing, and agent workflows.",
        reasoning: false,
        supportsReasoningEffort: true,
        reasoningId: "anthropic/claude-sonnet-4-5-thinking",
        toolCalling: true,
        multiModal: true,
        coding: true,
        isEnabled: true,
        isPremiumModel: true,
        contextWindow: 200_000,
      },
    ],
  },
  {
    id: "google",
    title: "Google",
    description: "Gemini models for fast multimodal responses and tool use.",
    websiteUrl: "https://ai.google.dev",
    sortOrder: 30,
    models: [
      {
        id: "google/gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        description: "Fast Gemini model for high-throughput hosted sessions.",
        reasoning: false,
        toolCalling: true,
        multiModal: true,
        coding: true,
        isEnabled: true,
        isPremiumModel: false,
        contextWindow: 1_000_000,
      },
    ],
  },
  {
    id: "qwen",
    title: "Qwen",
    description: "Qwen models for large-context coding, agent workflows, and reasoning variants.",
    websiteUrl: "https://qwen.aliyun.com/",
    sortOrder: 40,
    models: [
      {
        id: "qwen/qwen3.5-plus-02-15",
        name: "Qwen3.5 Plus",
        description: "1M context multimodal Qwen model with a separate thinking variant.",
        reasoning: false,
        reasoningId: "qwen/qwen3.5-plus-02-15-thinking",
        toolCalling: true,
        multiModal: true,
        coding: true,
        isEnabled: true,
        isPremiumModel: true,
        contextWindow: 1_000_000,
      },
    ],
  },
];
