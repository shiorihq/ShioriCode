import {
  mutationGeneric,
  queryGeneric,
  type GenericMutationCtx,
  type GenericQueryCtx,
} from "convex/server";
import { v } from "convex/values";

import {
  type HostedCatalogModel,
  type HostedCatalogProvider,
  DEFAULT_HOSTED_MODEL_CATALOG,
} from "./modelCatalog";

function sortProviders(providers: ReadonlyArray<HostedCatalogProvider>): HostedCatalogProvider[] {
  return providers.toSorted((left, right) => {
    if (left.sortOrder !== right.sortOrder) {
      return left.sortOrder - right.sortOrder;
    }
    return left.title.localeCompare(right.title);
  });
}

function sortModels<T extends { name: string; sortOrder: number }>(models: ReadonlyArray<T>): T[] {
  return models.toSorted((left, right) => {
    if (left.sortOrder !== right.sortOrder) {
      return left.sortOrder - right.sortOrder;
    }
    return left.name.localeCompare(right.name);
  });
}

async function readCatalogFromTables(ctx: GenericQueryCtx<any>): Promise<HostedCatalogProvider[]> {
  const providers = await ctx.db.query("providers").collect();
  if (providers.length === 0) {
    return [];
  }

  const orderedProviders = sortProviders(
    providers.map((provider) => ({
      id: provider.id,
      title: provider.title,
      description: provider.description,
      websiteUrl: provider.websiteUrl,
      sortOrder: provider.sortOrder,
      models: [],
    })),
  );

  return await Promise.all(
    orderedProviders.map(async (provider) => {
      const models = await ctx.db
        .query("models")
        .withIndex("by_provider_id", (q) => q.eq("providerId", provider.id))
        .collect();

      const orderedModels = sortModels(models).map<HostedCatalogModel>((model) => {
        const nextModel: HostedCatalogModel = {
          id: model.id,
          name: model.name,
          description: model.description,
          reasoning: model.reasoning,
          toolCalling: model.toolCalling,
          multiModal: model.multiModal,
          coding: model.coding ?? model.toolCalling,
          isEnabled: model.isEnabled,
          isPremiumModel: model.isPremiumModel,
          contextWindow: model.contextWindow,
        };

        if (model.supportsReasoningEffort !== undefined) {
          nextModel.supportsReasoningEffort = model.supportsReasoningEffort;
        }
        if (model.mandatoryReasoning !== undefined) {
          nextModel.mandatoryReasoning = model.mandatoryReasoning;
        }
        if (model.reasoningId !== undefined) {
          nextModel.reasoningId = model.reasoningId;
        }

        return nextModel;
      });

      return {
        id: provider.id,
        title: provider.title,
        description: provider.description,
        websiteUrl: provider.websiteUrl,
        sortOrder: provider.sortOrder,
        models: orderedModels,
      };
    }),
  );
}

async function replaceCatalog(
  ctx: GenericMutationCtx<any>,
  providers: ReadonlyArray<HostedCatalogProvider>,
) {
  const existingProviders = await ctx.db.query("providers").collect();
  const existingModels = await ctx.db.query("models").collect();
  const providerDocsById = new Map(existingProviders.map((provider) => [provider.id, provider]));
  const modelDocsByCompoundId = new Map(
    existingModels.map((model) => [`${model.providerId}:${model.id}`, model] as const),
  );
  const incomingProviderIds = new Set<string>();
  const incomingModelKeys = new Set<string>();

  for (const provider of sortProviders(providers)) {
    incomingProviderIds.add(provider.id);
    const existingProvider = providerDocsById.get(provider.id);
    if (existingProvider) {
      await ctx.db.patch(existingProvider._id, {
        title: provider.title,
        description: provider.description,
        websiteUrl: provider.websiteUrl,
        sortOrder: provider.sortOrder,
      });
    } else {
      await ctx.db.insert("providers", {
        id: provider.id,
        title: provider.title,
        description: provider.description,
        websiteUrl: provider.websiteUrl,
        sortOrder: provider.sortOrder,
      });
    }

    for (const [index, model] of provider.models.entries()) {
      const modelKey = `${provider.id}:${model.id}`;
      incomingModelKeys.add(modelKey);
      const existingModel = modelDocsByCompoundId.get(modelKey);
      const nextModelDoc = {
        providerId: provider.id,
        id: model.id,
        name: model.name,
        description: model.description,
        reasoning: model.reasoning,
        supportsReasoningEffort: model.supportsReasoningEffort,
        mandatoryReasoning: model.mandatoryReasoning,
        reasoningId: model.reasoningId,
        toolCalling: model.toolCalling,
        multiModal: model.multiModal,
        coding: model.coding ?? model.toolCalling,
        isEnabled: model.isEnabled,
        isPremiumModel: model.isPremiumModel,
        contextWindow: model.contextWindow,
        sortOrder: index,
      };
      if (existingModel) {
        await ctx.db.patch(existingModel._id, nextModelDoc);
      } else {
        await ctx.db.insert("models", nextModelDoc);
      }
    }
  }

  for (const model of existingModels) {
    const modelKey = `${model.providerId}:${model.id}`;
    if (!incomingModelKeys.has(modelKey)) {
      await ctx.db.delete(model._id);
    }
  }

  for (const provider of existingProviders) {
    if (!incomingProviderIds.has(provider.id)) {
      await ctx.db.delete(provider._id);
    }
  }
}

export const list = queryGeneric({
  args: {},
  handler: async (ctx) => {
    const catalog = await readCatalogFromTables(ctx);
    return catalog.length > 0 ? catalog : DEFAULT_HOSTED_MODEL_CATALOG;
  },
});

export const seedDefaultCatalog = mutationGeneric({
  args: {
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const hasProviders = await ctx.db.query("providers").first();
    if (hasProviders && args.force !== true) {
      return { seeded: false };
    }

    await replaceCatalog(ctx, DEFAULT_HOSTED_MODEL_CATALOG);
    return { seeded: true };
  },
});
