import { Effect } from "effect";

import {
  createHostedShioriHeaders,
  isHostedShioriAuthToken,
  normalizeHostedShioriApiBaseUrl,
} from "../hostedShioriApi";
import {
  HOSTED_SHIORI_DEVELOPMENT_CONVEX_URL,
  hostedShioriAuthTokenMatchesConvexUrl,
  resolveHostedShioriConvexUrl,
} from "shared/hostedShioriConvex";

export interface ShioriCodeBootstrapToolProfile {
  readonly supported: boolean;
  readonly tools: ReadonlyArray<string>;
}

export interface ShioriCodeBootstrapFeatureGate {
  readonly enabled: boolean;
}

export interface ShioriCodeBootstrapConfig {
  readonly approvalPolicies: {
    readonly fileWrite?: string;
    readonly shellCommand?: string;
    readonly destructiveChange?: string;
    readonly networkCommand?: string;
    readonly mcpSideEffect?: string;
    readonly outsideWorkspace?: string;
  };
  readonly protectedPaths: ReadonlyArray<string>;
  readonly browserUse: ShioriCodeBootstrapFeatureGate;
  readonly computerUse: ShioriCodeBootstrapFeatureGate;
  readonly mobileApp: ShioriCodeBootstrapFeatureGate;
  readonly kanban: ShioriCodeBootstrapFeatureGate;
  readonly subagents: {
    readonly enabled: boolean;
    readonly profiles: {
      readonly codex?: ShioriCodeBootstrapToolProfile;
      readonly claude?: ShioriCodeBootstrapToolProfile;
      readonly shiori?: ShioriCodeBootstrapToolProfile;
    };
  } | null;
}

export interface ShioriCodeBootstrapProbe {
  readonly bootstrap: ShioriCodeBootstrapConfig | null;
  readonly message: string | null;
}

const BOOTSTRAP_REQUEST_TIMEOUT_MS = 2_500;
const hostedShioriConvexUrl = resolveHostedShioriConvexUrl(
  process.env.VITE_CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL,
  process.env.VITE_DEV_SERVER_URL ? HOSTED_SHIORI_DEVELOPMENT_CONVEX_URL : undefined,
);

const CONSERVATIVE_BOOTSTRAP_DEFAULTS: ShioriCodeBootstrapConfig = {
  approvalPolicies: {
    fileWrite: "ask",
    shellCommand: "ask",
    destructiveChange: "ask",
    networkCommand: "ask",
    mcpSideEffect: "ask",
    outsideWorkspace: "ask",
  },
  protectedPaths: [
    ".git",
    ".env",
    ".env.*",
    "~/.ssh",
    "~/.aws",
    "~/.config/gcloud",
    "~/.shioricode",
  ],
  browserUse: { enabled: false },
  computerUse: { enabled: false },
  mobileApp: { enabled: false },
  kanban: { enabled: false },
  subagents: {
    enabled: false,
    profiles: {},
  },
};

function isExpectedHostedShioriAuthToken(token: string | null): token is string {
  return (
    isHostedShioriAuthToken(token) &&
    hostedShioriAuthTokenMatchesConvexUrl({
      token,
      convexUrl: hostedShioriConvexUrl,
    })
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeToolProfile(value: unknown): ShioriCodeBootstrapToolProfile | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const supported = value.supported === true;
  const tools = Array.isArray(value.tools)
    ? value.tools.flatMap((toolName) => (typeof toolName === "string" ? [toolName] : []))
    : [];

  return {
    supported,
    tools,
  };
}

function normalizeFeatureGate(value: unknown): ShioriCodeBootstrapFeatureGate {
  return {
    enabled: isRecord(value) && value.enabled === true,
  };
}

function normalizeApprovalPolicy(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeBootstrapConfig(payload: Record<string, unknown>): ShioriCodeBootstrapConfig {
  const approvalPolicies = isRecord(payload.approvalPolicies) ? payload.approvalPolicies : {};
  const rawSubagents = isRecord(payload.subagents) ? payload.subagents : null;
  const rawProfiles = rawSubagents && isRecord(rawSubagents.profiles) ? rawSubagents.profiles : {};
  const protectedPaths = Array.isArray(payload.protectedPaths)
    ? payload.protectedPaths.flatMap((entry) => (typeof entry === "string" ? [entry] : []))
    : [];
  const codexProfile = normalizeToolProfile(rawProfiles.codex);
  const claudeProfile = normalizeToolProfile(rawProfiles.claude);
  const shioriProfile = normalizeToolProfile(rawProfiles.shiori);
  const normalizedApprovalPolicies = {
    fileWrite:
      normalizeApprovalPolicy(approvalPolicies.fileWrite) ??
      CONSERVATIVE_BOOTSTRAP_DEFAULTS.approvalPolicies.fileWrite ??
      "ask",
    shellCommand:
      normalizeApprovalPolicy(approvalPolicies.shellCommand) ??
      CONSERVATIVE_BOOTSTRAP_DEFAULTS.approvalPolicies.shellCommand ??
      "ask",
    destructiveChange:
      normalizeApprovalPolicy(approvalPolicies.destructiveChange) ??
      CONSERVATIVE_BOOTSTRAP_DEFAULTS.approvalPolicies.destructiveChange ??
      "ask",
    networkCommand:
      normalizeApprovalPolicy(approvalPolicies.networkCommand) ??
      CONSERVATIVE_BOOTSTRAP_DEFAULTS.approvalPolicies.networkCommand ??
      "ask",
    mcpSideEffect:
      normalizeApprovalPolicy(approvalPolicies.mcpSideEffect) ??
      CONSERVATIVE_BOOTSTRAP_DEFAULTS.approvalPolicies.mcpSideEffect ??
      "ask",
    outsideWorkspace:
      normalizeApprovalPolicy(approvalPolicies.outsideWorkspace) ??
      CONSERVATIVE_BOOTSTRAP_DEFAULTS.approvalPolicies.outsideWorkspace ??
      "ask",
  };

  return {
    approvalPolicies: normalizedApprovalPolicies,
    protectedPaths: Array.from(
      new Set([...CONSERVATIVE_BOOTSTRAP_DEFAULTS.protectedPaths, ...protectedPaths]),
    ),
    browserUse: normalizeFeatureGate(payload.browserUse),
    computerUse: normalizeFeatureGate(payload.computerUse),
    mobileApp: normalizeFeatureGate(payload.mobileApp),
    kanban: normalizeFeatureGate(payload.kanban),
    subagents: rawSubagents
      ? {
          enabled: rawSubagents.enabled === true,
          profiles: {
            ...(codexProfile ? { codex: codexProfile } : {}),
            ...(claudeProfile ? { claude: claudeProfile } : {}),
            ...(shioriProfile ? { shiori: shioriProfile } : {}),
          },
        }
      : CONSERVATIVE_BOOTSTRAP_DEFAULTS.subagents,
  };
}

export const fetchShioriCodeBootstrap = Effect.fn("fetchShioriCodeBootstrap")(function* (input: {
  readonly apiBaseUrl: string;
  readonly authToken: string | null;
}): Effect.fn.Return<ShioriCodeBootstrapProbe> {
  if (!isExpectedHostedShioriAuthToken(input.authToken)) {
    return {
      bootstrap: null,
      message: null,
    };
  }
  const authToken = input.authToken;

  const response = yield* Effect.promise(() => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BOOTSTRAP_REQUEST_TIMEOUT_MS);
    return fetch(
      `${normalizeHostedShioriApiBaseUrl(input.apiBaseUrl)}/api/shiori-code/config/bootstrap`,
      {
        headers: createHostedShioriHeaders(authToken),
        signal: controller.signal,
      },
    )
      .catch(() => null)
      .finally(() => {
        clearTimeout(timeoutId);
      });
  });

  if (!response) {
    return {
      bootstrap: null,
      message: "Failed to load hosted ShioriCode bootstrap policy.",
    };
  }

  if (response.status === 401) {
    return {
      bootstrap: null,
      message: "Shiori account token is unavailable or expired. Sign out and sign back in.",
    };
  }

  if (!response.ok) {
    return {
      bootstrap: null,
      message: `Failed to load hosted ShioriCode bootstrap policy (${response.status}).`,
    };
  }

  const payloadResult = yield* Effect.result(
    Effect.tryPromise({
      try: () => response.json(),
      catch: (error) => error,
    }),
  );
  if (payloadResult._tag === "Failure" || !isRecord(payloadResult.success)) {
    return {
      bootstrap: CONSERVATIVE_BOOTSTRAP_DEFAULTS,
      message: "Failed to parse hosted ShioriCode bootstrap policy; using conservative defaults.",
    };
  }

  return {
    bootstrap: normalizeBootstrapConfig(payloadResult.success),
    message: null,
  };
});
