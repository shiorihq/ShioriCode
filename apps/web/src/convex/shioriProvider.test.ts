import { describe, expect, it } from "vitest";

import type { ServerProvider } from "contracts";

import {
  flattenHostedShioriModels,
  flattenHostedShioriSettingsModels,
  mergeHostedShioriProvider,
} from "./shioriProvider";

const baseProvider: ServerProvider = {
  provider: "shiori",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "unknown" },
  checkedAt: "2026-04-03T00:00:00.000Z",
  models: [
    {
      slug: "openai/gpt-5.4",
      name: "GPT-5.4",
      isCustom: false,
      capabilities: null,
    },
  ],
};

describe("flattenHostedShioriModels", () => {
  it("falls back to tool-calling models when legacy catalog rows omit coding metadata", () => {
    expect(
      flattenHostedShioriModels([
        {
          id: "openai",
          title: "OpenAI",
          description: "",
          websiteUrl: "https://openai.com",
          sortOrder: 10,
          models: [
            {
              id: "openai/gpt-5.4",
              name: "GPT-5.4",
              description: "",
              reasoning: true,
              toolCalling: true,
              multiModal: true,
              isEnabled: true,
              isPremiumModel: true,
              contextWindow: 400_000,
            },
          ],
        },
      ]),
    ).toEqual([
      {
        slug: "openai/gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        multiModal: true,
        capabilities: {
          reasoningEffortLevels: [],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ]);
  });

  it("prefixes hosted model ids with their provider id", () => {
    expect(
      flattenHostedShioriModels([
        {
          id: "openai",
          title: "OpenAI",
          description: "",
          websiteUrl: "https://openai.com",
          sortOrder: 10,
          models: [
            {
              id: "gpt-5.4",
              name: "GPT-5.4",
              description: "",
              reasoning: true,
              supportsReasoningEffort: true,
              mandatoryReasoning: true,
              toolCalling: true,
              multiModal: true,
              coding: true,
              isEnabled: true,
              isPremiumModel: true,
              contextWindow: 400_000,
            },
          ],
        },
      ]),
    ).toEqual([
      {
        slug: "openai/gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        multiModal: true,
        capabilities: {
          reasoningEffortLevels: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium", isDefault: true },
            { value: "high", label: "High" },
          ],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ]);
  });

  it("marks hosted models with reasoning aliases as toggleable thinking models", () => {
    expect(
      flattenHostedShioriModels([
        {
          id: "anthropic",
          title: "Anthropic",
          description: "",
          websiteUrl: "https://anthropic.com",
          sortOrder: 10,
          models: [
            {
              id: "claude-sonnet-4-5",
              name: "Claude Sonnet 4.5",
              description: "",
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
      ]),
    ).toEqual([
      {
        slug: "anthropic/claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        isCustom: false,
        multiModal: true,
        capabilities: {
          reasoningEffortLevels: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium", isDefault: true },
            { value: "high", label: "High" },
          ],
          supportsFastMode: false,
          supportsThinkingToggle: true,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ]);
  });

  it("keeps thinking toggle support for hosted models that expose only a reasoning variant id", () => {
    expect(
      flattenHostedShioriModels([
        {
          id: "qwen",
          title: "Qwen",
          description: "",
          websiteUrl: "https://qwen.aliyun.com",
          sortOrder: 10,
          models: [
            {
              id: "qwen/qwen3.5-plus-02-15",
              name: "Qwen3.5 Plus",
              description: "",
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
      ]),
    ).toEqual([
      {
        slug: "qwen/qwen3.5-plus-02-15",
        name: "Qwen3.5 Plus",
        isCustom: false,
        multiModal: true,
        capabilities: {
          reasoningEffortLevels: [],
          supportsFastMode: false,
          supportsThinkingToggle: true,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ]);
  });

  it("does not double-prefix catalog ids that are already canonical", () => {
    expect(
      flattenHostedShioriModels([
        {
          id: "anthropic",
          title: "Anthropic",
          description: "",
          websiteUrl: "https://anthropic.com",
          sortOrder: 10,
          models: [
            {
              id: "anthropic/claude-sonnet-4-5",
              name: "Claude Sonnet 4.5",
              description: "",
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
      ]),
    ).toEqual([
      {
        slug: "anthropic/claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        isCustom: false,
        multiModal: true,
        capabilities: {
          reasoningEffortLevels: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium", isDefault: true },
            { value: "high", label: "High" },
          ],
          supportsFastMode: false,
          supportsThinkingToggle: true,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ]);
  });

  it("filters out hosted models that are not enabled for Shiori Code", () => {
    expect(
      flattenHostedShioriModels([
        {
          id: "openai",
          title: "OpenAI",
          description: "",
          websiteUrl: "https://openai.com",
          sortOrder: 10,
          models: [
            {
              id: "gpt-5.4",
              name: "GPT-5.4",
              description: "",
              reasoning: true,
              toolCalling: true,
              multiModal: true,
              coding: false,
              isEnabled: true,
              isPremiumModel: true,
              contextWindow: 400_000,
            },
          ],
        },
      ]),
    ).toEqual([]);
  });

  it("preserves hosted multimodal support metadata", () => {
    expect(
      flattenHostedShioriModels([
        {
          id: "zhipu",
          title: "Zhipu",
          description: "",
          websiteUrl: "https://open.bigmodel.cn",
          sortOrder: 10,
          models: [
            {
              id: "glm-5.1",
              name: "GLM-5.1",
              description: "",
              reasoning: false,
              toolCalling: true,
              multiModal: false,
              coding: true,
              isEnabled: true,
              isPremiumModel: false,
              contextWindow: 128_000,
            },
          ],
        },
      ]),
    ).toEqual([
      {
        slug: "zhipu/glm-5.1",
        name: "GLM-5.1",
        isCustom: false,
        multiModal: false,
        capabilities: {
          reasoningEffortLevels: [],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ]);
  });
});

describe("flattenHostedShioriSettingsModels", () => {
  it("only keeps models explicitly marked with coding: true", () => {
    expect(
      flattenHostedShioriSettingsModels([
        {
          id: "openai",
          title: "OpenAI",
          description: "",
          websiteUrl: "https://openai.com",
          sortOrder: 10,
          models: [
            {
              id: "gpt-5.4",
              name: "GPT-5.4",
              description: "",
              reasoning: true,
              toolCalling: true,
              multiModal: true,
              isEnabled: true,
              isPremiumModel: true,
              contextWindow: 400_000,
            },
            {
              id: "gpt-5.4-mini",
              name: "GPT-5.4 Mini",
              description: "",
              reasoning: true,
              toolCalling: true,
              multiModal: true,
              coding: true,
              isEnabled: true,
              isPremiumModel: true,
              contextWindow: 400_000,
            },
          ],
        },
      ]),
    ).toEqual([
      {
        slug: "openai/gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        isCustom: false,
        multiModal: true,
        capabilities: {
          reasoningEffortLevels: [],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ]);
  });
});

describe("mergeHostedShioriProvider", () => {
  it("keeps the hosted provider ready when the user is signed out", () => {
    expect(
      mergeHostedShioriProvider(baseProvider, {
        isAuthLoading: false,
        isAuthenticated: false,
        isSubscriptionLoading: false,
        isPaidSubscriber: false,
        viewer: null,
        catalogProviders: undefined,
      }),
    ).toMatchObject({
      status: "ready",
      auth: { status: "unknown", label: "Sign in optional" },
    });
  });

  it("replaces fallback models with the hosted catalog after sign-in", () => {
    expect(
      mergeHostedShioriProvider(baseProvider, {
        isAuthLoading: false,
        isAuthenticated: true,
        isSubscriptionLoading: false,
        isPaidSubscriber: true,
        viewer: {
          _id: "user_1",
          name: "Octocat",
          email: "octocat@example.com",
          image: null,
        },
        catalogProviders: [
          {
            id: "openai",
            title: "OpenAI",
            description: "",
            websiteUrl: "https://openai.com",
            sortOrder: 10,
            models: [
              {
                id: "gpt-5.4-mini",
                name: "GPT-5.4 Mini",
                description: "",
                reasoning: true,
                toolCalling: true,
                multiModal: true,
                coding: true,
                isEnabled: true,
                isPremiumModel: false,
                contextWindow: 400_000,
              },
            ],
          },
        ],
      }),
    ).toMatchObject({
      status: "ready",
      auth: {
        status: "authenticated",
        label: "octocat@example.com",
      },
      models: [
        {
          slug: "openai/gpt-5.4-mini",
          name: "GPT-5.4 Mini",
        },
      ],
    });
  });

  it("keeps the hosted provider ready without a paid Shiori plan", () => {
    expect(
      mergeHostedShioriProvider(baseProvider, {
        isAuthLoading: false,
        isAuthenticated: true,
        isSubscriptionLoading: false,
        isPaidSubscriber: false,
        viewer: {
          _id: "user_1",
          name: "Octocat",
          email: "octocat@example.com",
          image: null,
        },
        catalogProviders: undefined,
      }),
    ).toMatchObject({
      status: "ready",
      auth: {
        status: "authenticated",
        label: "octocat@example.com",
      },
      message: undefined,
    });
  });
});
