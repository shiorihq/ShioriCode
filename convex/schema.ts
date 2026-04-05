import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,
  users: defineTable({
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    image: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
  }).index("email", ["email"]),
  providers: defineTable({
    id: v.string(),
    title: v.string(),
    description: v.string(),
    websiteUrl: v.string(),
    sortOrder: v.number(),
  }).index("by_provider_id", ["id"]),
  models: defineTable({
    id: v.string(),
    providerId: v.string(),
    name: v.string(),
    description: v.string(),
    reasoning: v.boolean(),
    supportsReasoningEffort: v.optional(v.boolean()),
    mandatoryReasoning: v.optional(v.boolean()),
    reasoningId: v.optional(v.string()),
    toolCalling: v.boolean(),
    multiModal: v.boolean(),
    coding: v.optional(v.boolean()),
    isEnabled: v.boolean(),
    isPremiumModel: v.boolean(),
    contextWindow: v.number(),
    sortOrder: v.number(),
  })
    .index("by_model_id", ["id"])
    .index("by_provider_id", ["providerId"]),
});
