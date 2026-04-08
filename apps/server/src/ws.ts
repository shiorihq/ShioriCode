import { Duration, Effect, Layer, Option, Queue, Ref, Result, Schema, Stream } from "effect";
import {
  OnboardingError,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSubagentDetailError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_WS_METHODS,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  OrchestrationReplayEventsError,
  type ServerProvider,
  type ServerProviderUsageSnapshot,
  type TerminalEvent,
  WS_METHODS,
  WsRpcGroup,
} from "contracts";
import { clamp } from "effect/Number";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import {
  completeOnboardingStep,
  resetOnboardingProgress,
  resolveOnboardingState,
} from "shared/onboarding";

import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { ServerConfig } from "./config";
import { GitCore } from "./git/Services/GitCore";
import { GitManager } from "./git/Services/GitManager";
import { Keybindings } from "./keybindings";
import { Open, resolveAvailableEditors } from "./open";
import { normalizeDispatchCommand } from "./orchestration/Normalizer";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { SubagentDetailQuery } from "./orchestration/Services/SubagentDetailQuery.ts";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry";
import { ProviderService } from "./provider/Services/ProviderService";
import type { ClaudeUsageSnapshot, CodexUsageSnapshot } from "./provider/Services/ProviderUsage.ts";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";
import { ServerSettingsService } from "./serverSettings";
import { HostedShioriAuthTokenStore } from "./hostedShioriAuthTokenStore";
import { HostedBillingService } from "./hostedBilling";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import {
  summarizeClientCommand,
  summarizeSettingsPatch,
  withTelemetrySource,
} from "./telemetry/RpcTelemetry.ts";
import { TerminalManager } from "./terminal/Services/Manager";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries";
import { WorkspaceFileSystem } from "./workspace/Services/WorkspaceFileSystem";
import { WorkspacePathOutsideRootError } from "./workspace/Services/WorkspacePaths";

function toServerProviderUsageSnapshot(
  usage: CodexUsageSnapshot | ClaudeUsageSnapshot,
): ServerProviderUsageSnapshot {
  return usage.provider === "codex"
    ? {
        provider: "codex",
        source: "app-server",
        available: true,
        unavailableReason: null,
        primary: usage.rateLimits?.primary
          ? {
              usedPercent: usage.rateLimits.primary.usedPercent,
              resetsAt: usage.rateLimits.primary.resetsAt,
              ...(usage.rateLimits.primary.windowDurationMinutes !== null
                ? {
                    windowDurationMinutes: usage.rateLimits.primary.windowDurationMinutes,
                  }
                : {}),
            }
          : null,
        secondary: usage.rateLimits?.secondary
          ? {
              usedPercent: usage.rateLimits.secondary.usedPercent,
              resetsAt: usage.rateLimits.secondary.resetsAt,
              ...(usage.rateLimits.secondary.windowDurationMinutes !== null
                ? {
                    windowDurationMinutes: usage.rateLimits.secondary.windowDurationMinutes,
                  }
                : {}),
            }
          : null,
      }
    : {
        provider: "claudeAgent",
        source: "oauth-api",
        available: usage.available,
        unavailableReason: usage.unavailableReason,
        fiveHour: usage.windows.fiveHour
          ? {
              usedPercent: usage.windows.fiveHour.usedPercent,
              resetsAt: usage.windows.fiveHour.resetsAt,
            }
          : null,
        sevenDay: usage.windows.sevenDay
          ? {
              usedPercent: usage.windows.sevenDay.usedPercent,
              resetsAt: usage.windows.sevenDay.resetsAt,
            }
          : null,
      };
}

const WsRpcLayer = WsRpcGroup.toLayer(
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const checkpointDiffQuery = yield* CheckpointDiffQuery;
    const subagentDetailQuery = yield* SubagentDetailQuery;
    const keybindings = yield* Keybindings;
    const open = yield* Open;
    const gitManager = yield* GitManager;
    const git = yield* GitCore;
    const terminalManager = yield* TerminalManager;
    const providerRegistry = yield* ProviderRegistry;
    const providerService = yield* ProviderService;
    const config = yield* ServerConfig;
    const lifecycleEvents = yield* ServerLifecycleEvents;
    const serverSettings = yield* ServerSettingsService;
    const hostedShioriAuthTokenStore = yield* HostedShioriAuthTokenStore;
    const hostedBilling = yield* HostedBillingService;
    const startup = yield* ServerRuntimeStartup;
    const workspaceEntries = yield* WorkspaceEntries;
    const workspaceFileSystem = yield* WorkspaceFileSystem;
    const analytics = yield* AnalyticsService;
    const latestProvidersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>([]);

    const readProvidersForConfig = Effect.gen(function* () {
      const providersResult = yield* providerRegistry.getProviders.pipe(
        Effect.tap((providers) => Ref.set(latestProvidersRef, providers)),
        Effect.timeoutOption(Duration.millis(750)),
        Effect.result,
      );

      if (Result.isSuccess(providersResult) && Option.isSome(providersResult.success)) {
        return providersResult.success.value;
      }

      return yield* Ref.get(latestProvidersRef);
    });

    const loadServerConfig = Effect.gen(function* () {
      const keybindingsConfig = yield* keybindings.loadConfigState;
      const providers = yield* readProvidersForConfig;
      const settings = yield* serverSettings.getSettings;

      return {
        cwd: config.cwd,
        serverInstancePath: config.serverInstancePath,
        keybindingsConfigPath: config.keybindingsConfigPath,
        keybindings: keybindingsConfig.keybindings,
        issues: keybindingsConfig.issues,
        providers,
        availableEditors: resolveAvailableEditors(),
        settings,
      };
    });

    return WsRpcGroup.of({
      [ORCHESTRATION_WS_METHODS.getSnapshot]: (_input) =>
        orchestrationEngine.getReadModel().pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetSnapshotError({
                message: "Failed to load orchestration snapshot",
                cause,
              }),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
        Effect.gen(function* () {
          const normalizedCommand = yield* normalizeDispatchCommand(command);
          const result = yield* startup.enqueueCommand(
            orchestrationEngine.dispatch(normalizedCommand),
          );
          yield* analytics.record(
            "orchestration.command.dispatched",
            summarizeClientCommand(command as Parameters<typeof summarizeClientCommand>[0]),
          );
          if (normalizedCommand.type === "thread.archive") {
            yield* terminalManager.close({ threadId: normalizedCommand.threadId }).pipe(
              Effect.catch((error) =>
                Effect.logWarning("failed to close thread terminals after archive", {
                  threadId: normalizedCommand.threadId,
                  error: error.message,
                }),
              ),
            );
          }
          return result;
        }).pipe(
          Effect.mapError((cause) =>
            Schema.is(OrchestrationDispatchCommandError)(cause)
              ? cause
              : new OrchestrationDispatchCommandError({
                  message: "Failed to dispatch orchestration command",
                  cause,
                }),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
        checkpointDiffQuery.getTurnDiff(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetTurnDiffError({
                message: "Failed to load turn diff",
                cause,
              }),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
        checkpointDiffQuery.getFullThreadDiff(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetFullThreadDiffError({
                message: "Failed to load full thread diff",
                cause,
              }),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.getSubagentDetail]: (input) =>
        subagentDetailQuery.getSubagentDetail(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetSubagentDetailError({
                message: "Failed to load subagent details",
                cause,
              }),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.replayEvents]: (input) =>
        Stream.runCollect(
          orchestrationEngine.readEvents(
            clamp(input.fromSequenceExclusive, { maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
          ),
        ).pipe(
          Effect.map((events) => Array.from(events)),
          Effect.mapError(
            (cause) =>
              new OrchestrationReplayEventsError({
                message: "Failed to replay orchestration events",
                cause,
              }),
          ),
        ),
      [WS_METHODS.subscribeOrchestrationDomainEvents]: (_input) =>
        orchestrationEngine.streamDomainEvents,
      [WS_METHODS.serverGetConfig]: (_input) => loadServerConfig,
      [WS_METHODS.serverRefreshProviders]: (_input) =>
        providerRegistry.refresh().pipe(
          Effect.tap((providers) =>
            analytics.record("server.providers.refreshed", {
              providerCount: providers.length,
            }),
          ),
          Effect.map((providers) => ({ providers })),
        ),
      [WS_METHODS.serverUpsertKeybinding]: (rule) =>
        Effect.gen(function* () {
          const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
          return { keybindings: keybindingsConfig, issues: [] };
        }),
      [WS_METHODS.serverGetSettings]: (_input) => serverSettings.getSettings,
      [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
        serverSettings
          .updateSettings(patch)
          .pipe(
            Effect.tap(() =>
              analytics.record("server.settings.updated", summarizeSettingsPatch(patch)),
            ),
          ),
      [WS_METHODS.serverSetShioriAuthToken]: ({ token }) =>
        Effect.gen(function* () {
          yield* Effect.logInfo("shiori account auth token updated", {
            present: token !== null,
          });
          yield* hostedShioriAuthTokenStore.setToken(token);
          yield* analytics.record("server.shiori_auth.updated", {
            hasToken: token !== null,
          });
          return {};
        }),
      [WS_METHODS.serverGetProviderUsage]: ({ provider }) =>
        providerService
          .readUsage(provider)
          .pipe(Effect.map(toServerProviderUsageSnapshot), Effect.orDie),
      [WS_METHODS.serverGetHostedBillingSnapshot]: (_input) => hostedBilling.getSnapshot,
      [WS_METHODS.serverCreateHostedBillingCheckout]: (input) =>
        hostedBilling.createCheckout(input),
      [WS_METHODS.serverCreateHostedBillingPortal]: (input) => hostedBilling.createPortal(input),
      [WS_METHODS.onboardingGetState]: (_input) =>
        serverSettings.getSettings.pipe(
          Effect.map((settings) => resolveOnboardingState(settings.onboarding)),
          Effect.mapError(
            (cause) =>
              new OnboardingError({
                message: "Failed to load onboarding state",
                cause,
              }),
          ),
        ),
      [WS_METHODS.onboardingCompleteStep]: (input) =>
        Effect.gen(function* () {
          const settings = yield* serverSettings.getSettings.pipe(
            Effect.mapError(
              (cause) =>
                new OnboardingError({
                  message: "Failed to load onboarding state",
                  cause,
                }),
            ),
          );
          const completion = completeOnboardingStep(settings.onboarding, input.stepId);

          if (!completion.accepted) {
            const expectedStepId = completion.expectedStepId;
            return yield* new OnboardingError({
              message:
                expectedStepId === null
                  ? "Onboarding is already complete."
                  : `Step "${input.stepId}" cannot be completed yet. Complete "${expectedStepId}" first.`,
            });
          }

          if (!completion.changed) {
            return resolveOnboardingState(completion.progress);
          }

          const nextSettings = yield* serverSettings
            .updateSettings({
              onboarding: completion.progress,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OnboardingError({
                    message: "Failed to persist onboarding state",
                    cause,
                  }),
              ),
            );
          yield* analytics.record("onboarding.step.completed", {
            stepId: input.stepId,
            completed: resolveOnboardingState(nextSettings.onboarding).completed,
          });
          return resolveOnboardingState(nextSettings.onboarding);
        }),
      [WS_METHODS.onboardingReset]: (_input) =>
        serverSettings
          .updateSettings({
            onboarding: resetOnboardingProgress(),
          })
          .pipe(
            Effect.tap(() => analytics.record("onboarding.reset")),
            Effect.map((settings) => resolveOnboardingState(settings.onboarding)),
            Effect.mapError(
              (cause) =>
                new OnboardingError({
                  message: "Failed to reset onboarding state",
                  cause,
                }),
            ),
          ),
      [WS_METHODS.telemetryCapture]: (input) =>
        analytics
          .record(input.event, withTelemetrySource("web-client", input.properties))
          .pipe(Effect.as({})),
      [WS_METHODS.telemetryLog]: (input) =>
        Effect.gen(function* () {
          const context = withTelemetrySource("web-client", input.context);
          switch (input.level) {
            case "warn":
              yield* Effect.logWarning(input.message, context);
              break;
            case "error":
              yield* Effect.logError(input.message, context);
              break;
            case "info":
            default:
              yield* Effect.logInfo(input.message, context);
              break;
          }
          return {};
        }),
      [WS_METHODS.projectsSearchEntries]: (input) =>
        workspaceEntries.search(input).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectSearchEntriesError({
                message: `Failed to search workspace entries: ${cause.detail}`,
                cause,
              }),
          ),
        ),
      [WS_METHODS.projectsWriteFile]: (input) =>
        workspaceFileSystem.writeFile(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : "Failed to write workspace file";
            return new ProjectWriteFileError({
              message,
              cause,
            });
          }),
        ),
      [WS_METHODS.shellOpenInEditor]: (input) => open.openInEditor(input),
      [WS_METHODS.gitStatus]: (input) => gitManager.status(input),
      [WS_METHODS.gitResolvePullRequest]: (input) => gitManager.resolvePullRequest(input),
      [WS_METHODS.gitPreparePullRequestThread]: (input) =>
        gitManager.preparePullRequestThread(input),
      [WS_METHODS.gitListBranches]: (input) => git.listBranches(input),
      [WS_METHODS.gitCreateWorktree]: (input) => git.createWorktree(input),
      [WS_METHODS.gitRemoveWorktree]: (input) => git.removeWorktree(input),
      [WS_METHODS.gitCreateBranch]: (input) => git.createBranch(input),
      [WS_METHODS.gitCheckout]: (input) => Effect.scoped(git.checkoutBranch(input)),
      [WS_METHODS.gitInit]: (input) => git.initRepo(input),
      [WS_METHODS.terminalOpen]: (input) => terminalManager.open(input),
      [WS_METHODS.terminalWrite]: (input) => terminalManager.write(input),
      [WS_METHODS.terminalResize]: (input) => terminalManager.resize(input),
      [WS_METHODS.terminalClear]: (input) => terminalManager.clear(input),
      [WS_METHODS.terminalRestart]: (input) => terminalManager.restart(input),
      [WS_METHODS.terminalClose]: (input) => terminalManager.close(input),
      [WS_METHODS.subscribeTerminalEvents]: (_input) =>
        Stream.callback<TerminalEvent>((queue) =>
          Effect.acquireRelease(
            terminalManager.subscribe((event) => Queue.offer(queue, event)),
            (unsubscribe) => Effect.sync(unsubscribe),
          ),
        ),
      [WS_METHODS.subscribeServerConfig]: (_input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const keybindingsUpdates = keybindings.streamChanges.pipe(
              Stream.map((event) => ({
                version: 1 as const,
                type: "keybindingsUpdated" as const,
                payload: {
                  issues: event.issues,
                },
              })),
            );
            const providerStatuses = providerRegistry.streamChanges.pipe(
              Stream.mapEffect((providers) =>
                Ref.set(latestProvidersRef, providers).pipe(
                  Effect.as({
                    version: 1 as const,
                    type: "providerStatuses" as const,
                    payload: { providers },
                  }),
                ),
              ),
            );
            const settingsUpdates = serverSettings.streamChanges.pipe(
              Stream.map((settings) => ({
                version: 1 as const,
                type: "settingsUpdated" as const,
                payload: { settings },
              })),
            );

            return Stream.concat(
              Stream.make({
                version: 1 as const,
                type: "snapshot" as const,
                config: yield* loadServerConfig,
              }),
              Stream.merge(keybindingsUpdates, Stream.merge(providerStatuses, settingsUpdates)),
            );
          }),
        ),
      [WS_METHODS.subscribeServerLifecycle]: (_input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const snapshot = yield* lifecycleEvents.snapshot;
            const snapshotEvents = Array.from(snapshot.events).toSorted(
              (left, right) => left.sequence - right.sequence,
            );
            const liveEvents = lifecycleEvents.stream.pipe(
              Stream.filter((event) => event.sequence > snapshot.sequence),
            );
            return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
          }),
        ),
    });
  }),
);

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup).pipe(
      Effect.provide(Layer.mergeAll(WsRpcLayer, RpcSerialization.layerJson)),
    );
    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const config = yield* ServerConfig;
        if (config.authToken) {
          const url = HttpServerRequest.toURL(request);
          if (Option.isNone(url)) {
            return HttpServerResponse.text("Invalid WebSocket URL", { status: 400 });
          }
          const token = url.value.searchParams.get("token");
          if (token !== config.authToken) {
            return HttpServerResponse.text("Unauthorized WebSocket connection", { status: 401 });
          }
        }
        return yield* rpcWebSocketHttpEffect;
      }),
    );
  }),
);
