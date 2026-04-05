import type { FunctionReference } from "convex/server";
import { makeFunctionReference } from "convex/server";

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

export interface HostedViewer {
  _id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

export interface HostedSubscriptionSummary {
  plan: string;
}

export interface HostedUsageStats {
  percentUsed: number;
  resetDate: string | null;
  fiveHourPercentUsed: number;
  fiveHourResetsIn: number;
  isRateLimited: boolean;
  isBudgetExhausted: boolean;
}

export interface HostedFiveHourUsage {
  spentMicros: number;
  fiveHourBudgetMicros: number | null;
}

export interface HostedUserWithUsage {
  _id: string;
  dollarBudgetUsedMicrosThisPeriod: number;
  freeMessagesUsedThisMonth: number;
  freeMessagesRemaining: number;
  subscription: HostedSubscriptionSummary | null;
}

type PublicQueryReference<Args extends Record<string, unknown>, ReturnValue> = FunctionReference<
  "query",
  "public",
  Args,
  ReturnValue
>;

export const hostedModelsListQuery = makeFunctionReference("models:list") as PublicQueryReference<
  Record<string, never>,
  HostedCatalogProvider[]
>;

export const hostedCurrentUserQuery = makeFunctionReference(
  "users:getCurrentUser",
) as PublicQueryReference<Record<string, never>, HostedViewer | null>;

export const hostedUpdateProfileMutation = makeFunctionReference(
  "users:updateProfile",
) as PublicMutationReference<{ name?: string; image?: string }, { success: boolean }>;

export const hostedInitiatePasswordChangeMutation = makeFunctionReference(
  "users:initiatePasswordChange",
) as PublicMutationReference<Record<string, never>, { email: string }>;

export const hostedUsageStatsQuery = makeFunctionReference(
  "usage:getUsageStats",
) as PublicQueryReference<
  {
    limit?: number;
  },
  HostedUsageStats
>;

export const hostedFiveHourUsageQuery = makeFunctionReference(
  "usage:getFiveHourUsage",
) as PublicQueryReference<Record<string, never>, HostedFiveHourUsage>;

export const hostedUserWithUsageQuery = makeFunctionReference(
  "usage:getUserWithUsage",
) as PublicQueryReference<
  {
    userId?: string;
  },
  HostedUserWithUsage | null
>;

// -- Tickets (feedback / support) --

export interface HostedTicket {
  _id: string;
  _creationTime: number;
  userId: string;
  topic: string;
  message: string;
  status: "open" | "in_progress" | "resolved" | "closed";
  priority: "low" | "medium" | "high";
  adminNotes?: string;
  createdAt: number;
  updatedAt: number;
}

type PublicMutationReference<Args extends Record<string, unknown>, ReturnValue> = FunctionReference<
  "mutation",
  "public",
  Args,
  ReturnValue
>;

export const hostedTicketCreateMutation = makeFunctionReference(
  "tickets:create",
) as PublicMutationReference<{ topic: string; message: string }, string>;

export const hostedTicketListQuery = makeFunctionReference(
  "tickets:listUserTickets",
) as PublicQueryReference<Record<string, never>, HostedTicket[]>;
