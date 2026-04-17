import { Effect } from "effect";

import {
  createHostedShioriHeaders,
  isHostedShioriAuthToken,
  normalizeHostedShioriApiBaseUrl,
} from "../hostedShioriApi";

export interface ShioriCodeBootstrapToolProfile {
  readonly supported: boolean;
  readonly tools: ReadonlyArray<string>;
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

function normalizeBootstrapConfig(payload: Record<string, unknown>): ShioriCodeBootstrapConfig {
  const approvalPolicies = isRecord(payload.approvalPolicies) ? payload.approvalPolicies : {};
  const rawSubagents = isRecord(payload.subagents) ? payload.subagents : null;
  const rawProfiles = rawSubagents && isRecord(rawSubagents.profiles) ? rawSubagents.profiles : {};

  return {
    approvalPolicies: {
      ...(typeof approvalPolicies.fileWrite === "string"
        ? { fileWrite: approvalPolicies.fileWrite }
        : {}),
      ...(typeof approvalPolicies.shellCommand === "string"
        ? { shellCommand: approvalPolicies.shellCommand }
        : {}),
      ...(typeof approvalPolicies.destructiveChange === "string"
        ? { destructiveChange: approvalPolicies.destructiveChange }
        : {}),
      ...(typeof approvalPolicies.networkCommand === "string"
        ? { networkCommand: approvalPolicies.networkCommand }
        : {}),
      ...(typeof approvalPolicies.mcpSideEffect === "string"
        ? { mcpSideEffect: approvalPolicies.mcpSideEffect }
        : {}),
      ...(typeof approvalPolicies.outsideWorkspace === "string"
        ? { outsideWorkspace: approvalPolicies.outsideWorkspace }
        : {}),
    },
    protectedPaths: Array.isArray(payload.protectedPaths)
      ? payload.protectedPaths.flatMap((entry) => (typeof entry === "string" ? [entry] : []))
      : [],
    subagents: rawSubagents
      ? {
          enabled: rawSubagents.enabled === true,
          profiles: {
            ...(normalizeToolProfile(rawProfiles.codex)
              ? { codex: normalizeToolProfile(rawProfiles.codex)! }
              : {}),
            ...(normalizeToolProfile(rawProfiles.claude)
              ? { claude: normalizeToolProfile(rawProfiles.claude)! }
              : {}),
            ...(normalizeToolProfile(rawProfiles.shiori)
              ? { shiori: normalizeToolProfile(rawProfiles.shiori)! }
              : {}),
          },
        }
      : null,
  };
}

export const fetchShioriCodeBootstrap = Effect.fn("fetchShioriCodeBootstrap")(function* (input: {
  readonly apiBaseUrl: string;
  readonly authToken: string | null;
}): Effect.fn.Return<ShioriCodeBootstrapProbe> {
  if (!isHostedShioriAuthToken(input.authToken)) {
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

  const payload = yield* Effect.promise(() =>
    response
      .json()
      .then((value) => (isRecord(value) ? value : {}))
      .catch(() => ({})),
  );

  return {
    bootstrap: normalizeBootstrapConfig(payload),
    message: null,
  };
});
