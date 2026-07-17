import path from "node:path";

import { Duration, Effect, Layer, Option, Queue, Ref, Result, Schema, Stream } from "effect";
import {
  OnboardingError,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSubagentDetailError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_WS_METHODS,
  ProjectReadFileError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  OrchestrationReplayEventsError,
  type OrchestrationEvent,
  type ServerProvider,
  type ServerProviderUsageSnapshot,
  ServerSettingsError,
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

import { EnvironmentAuth } from "./auth/EnvironmentAuth";
import { RemoteAccess } from "./remote/RemoteAccess";
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
import {
  authenticateEffectiveMcpServer,
  listEffectiveMcpServerRows,
  removeExternalMcpServer,
} from "./provider/mcpServers.ts";
import { listEffectiveSkills, removeEffectiveSkill } from "./provider/skills.ts";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";
import { ServerSettingsService } from "./serverSettings";
import { AutomationService } from "./automations/Services/AutomationService";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import { BrowserPanelRequests } from "./browserPanelRequests.ts";
import { ComputerUseManager } from "./computer/Services/ComputerUseManager";
import {
  summarizeClientCommand,
  summarizeSettingsPatch,
  withTelemetrySource,
} from "./telemetry/RpcTelemetry.ts";
import { TerminalManager } from "./terminal/Services/Manager";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries";
import { WorkspaceFileSystem } from "./workspace/Services/WorkspaceFileSystem";
import { WorkspacePathOutsideRootError } from "./workspace/Services/WorkspacePaths";

const ORCHESTRATION_WS_LIVE_EVENT_BUFFER_CAPACITY = 2_048;

function makeBufferedLiveOrchestrationEventStream(
  source: Stream.Stream<OrchestrationEvent>,
): Stream.Stream<OrchestrationEvent> {
  return Stream.scoped(
    Stream.fromEffect(
      Effect.gen(function* () {
        const queue = yield* Queue.sliding<OrchestrationEvent>(
          ORCHESTRATION_WS_LIVE_EVENT_BUFFER_CAPACITY,
        );
        yield* Effect.forkScoped(
          Stream.runForEach(source, (event) => Queue.offer(queue, event).pipe(Effect.asVoid)),
        );
        return queue;
      }),
    ).pipe(Stream.flatMap((queue) => Stream.fromQueue(queue))),
  );
}

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
        ...(usage.rateLimits?.planType !== undefined
          ? { planType: usage.rateLimits.planType }
          : {}),
        ...(usage.rateLimits?.individualLimit !== undefined
          ? { individualLimit: usage.rateLimits.individualLimit }
          : {}),
        ...(usage.rateLimits?.rateLimitReachedType !== undefined
          ? { rateLimitReachedType: usage.rateLimits.rateLimitReachedType }
          : {}),
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
    const startup = yield* ServerRuntimeStartup;
    const workspaceEntries = yield* WorkspaceEntries;
    const workspaceFileSystem = yield* WorkspaceFileSystem;
    const analytics = yield* AnalyticsService;
    const browserPanelRequests = yield* BrowserPanelRequests;
    const computer = yield* ComputerUseManager;
    const automations = yield* AutomationService;
    const environmentAuth = yield* EnvironmentAuth;
    const remoteAccess = yield* RemoteAccess;
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
        makeBufferedLiveOrchestrationEventStream(orchestrationEngine.streamDomainEvents),
      [WS_METHODS.subscribeBrowserPanelCommands]: (_input) => browserPanelRequests.stream,
      [WS_METHODS.browserPanelCompleteCommand]: (input) =>
        browserPanelRequests.completeCommand(input).pipe(Effect.as({})),
      [WS_METHODS.computerGetPermissions]: (_input) => computer.getPermissions,
      [WS_METHODS.computerRequestPermission]: (input) => computer.requestPermission(input),
      [WS_METHODS.computerShowPermissionGuide]: (input) => computer.showPermissionGuide(input),
      [WS_METHODS.computerCreateSession]: (_input) => computer.createSession,
      [WS_METHODS.computerCloseSession]: (input) =>
        computer.closeSession(input).pipe(Effect.as({})),
      [WS_METHODS.computerScreenshot]: (input) => computer.screenshot(input),
      [WS_METHODS.computerListApps]: (input) => computer.listApps(input),
      [WS_METHODS.computerFocusApp]: (input) => computer.focusApp(input),
      [WS_METHODS.computerFocusWindow]: (input) => computer.focusWindow(input),
      [WS_METHODS.computerClick]: (input) => computer.click(input),
      [WS_METHODS.computerDoubleClick]: (input) => computer.doubleClick(input),
      [WS_METHODS.computerRightClick]: (input) => computer.rightClick(input),
      [WS_METHODS.computerMove]: (input) => computer.move(input),
      [WS_METHODS.computerDrag]: (input) => computer.drag(input),
      [WS_METHODS.computerType]: (input) => computer.type(input),
      [WS_METHODS.computerKey]: (input) => computer.key(input),
      [WS_METHODS.computerScroll]: (input) => computer.scroll(input),
      [WS_METHODS.computerWait]: (input) => computer.wait(input),
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
      [WS_METHODS.serverListMcpServers]: (_input) =>
        serverSettings.getSettings.pipe(
          Effect.flatMap((settings) =>
            Effect.tryPromise({
              try: () =>
                listEffectiveMcpServerRows({
                  settings,
                  cwd: config.cwd,
                  oauthStorageDir: path.join(config.stateDir, "mcp-oauth"),
                }),
              catch: (cause) =>
                new ServerSettingsError({
                  settingsPath: config.settingsPath,
                  detail: "failed to list effective MCP servers",
                  cause,
                }),
            }),
          ),
        ),
      [WS_METHODS.serverAuthenticateMcpServer]: (input) =>
        serverSettings.getSettings.pipe(
          Effect.flatMap((settings) =>
            Effect.tryPromise({
              try: () =>
                authenticateEffectiveMcpServer({
                  settings,
                  target: input,
                  cwd: config.cwd,
                  oauthStorageDir: path.join(config.stateDir, "mcp-oauth"),
                }),
              catch: (cause) =>
                new ServerSettingsError({
                  settingsPath: config.settingsPath,
                  detail: "failed to authenticate MCP server",
                  cause,
                }),
            }),
          ),
          Effect.as({}),
        ),
      [WS_METHODS.serverRemoveMcpServer]: (input) =>
        Effect.tryPromise({
          try: () => removeExternalMcpServer(input),
          catch: (cause) =>
            new ServerSettingsError({
              settingsPath: config.settingsPath,
              detail: "failed to remove MCP server",
              cause,
            }),
        }).pipe(Effect.as({})),
      [WS_METHODS.serverListSkills]: (_input) =>
        serverSettings.getSettings.pipe(
          Effect.flatMap((settings) =>
            Effect.tryPromise({
              try: () =>
                listEffectiveSkills({
                  cwd: config.cwd,
                  codexHomePath: settings.providers.codex.homePath,
                }),
              catch: (cause) =>
                new ServerSettingsError({
                  settingsPath: config.settingsPath,
                  detail: "failed to list effective skills",
                  cause,
                }),
            }),
          ),
        ),
      [WS_METHODS.serverRemoveSkill]: (input) =>
        Effect.tryPromise({
          try: () => removeEffectiveSkill(input),
          catch: (cause) =>
            new ServerSettingsError({
              settingsPath: config.settingsPath,
              detail: "failed to remove skill",
              cause,
            }),
        }).pipe(Effect.as({})),
      [WS_METHODS.serverGetProviderUsage]: ({ provider }) =>
        providerService
          .readUsage(provider)
          .pipe(Effect.map(toServerProviderUsageSnapshot), Effect.orDie),
      [WS_METHODS.remoteGetStatus]: (_input) => remoteAccess.getStatus(),
      [WS_METHODS.remoteSetCredentials]: (input) =>
        Effect.gen(function* () {
          environmentAuth.setCredentials(input);
          return yield* remoteAccess.getStatus();
        }),
      [WS_METHODS.remoteSetExposure]: (input) => remoteAccess.setExposure(input),
      [WS_METHODS.remoteBeginLinkSignIn]: (input) => remoteAccess.beginLinkSignIn(input),
      [WS_METHODS.remoteDisconnectLinkAccount]: (_input) => remoteAccess.disconnectLinkAccount(),
      [WS_METHODS.remoteRevokeSession]: (input) =>
        Effect.gen(function* () {
          environmentAuth.revokeSession(input.sessionId);
          return yield* remoteAccess.getStatus();
        }),
      [WS_METHODS.remoteTestConnection]: (_input) => remoteAccess.testConnection(),
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
      [WS_METHODS.automationsList]: (_input) => automations.list,
      [WS_METHODS.automationsCreate]: (input) => automations.create(input),
      [WS_METHODS.automationsUpdate]: (input) => automations.update(input),
      [WS_METHODS.automationsDelete]: (input) => automations.delete(input),
      [WS_METHODS.automationsRunNow]: (input) => automations.runNow(input),
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
      [WS_METHODS.projectsReadFile]: (input) =>
        workspaceFileSystem.readFile(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : `Failed to read workspace file: ${cause.detail}`;
            return new ProjectReadFileError({
              message,
              cause,
            });
          }),
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
      [WS_METHODS.gitListOpenPullRequests]: (input) => gitManager.listOpenPullRequests(input),
      [WS_METHODS.gitGetPullRequestDiff]: (input) => gitManager.getPullRequestDiff(input),
      [WS_METHODS.gitSummarizePullRequest]: (input) => gitManager.summarizePullRequest(input),
      [WS_METHODS.gitGetPullRequestConversation]: (input) =>
        gitManager.getPullRequestConversation(input),
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
        const auth = yield* EnvironmentAuth;
        const url = HttpServerRequest.toURL(request);
        if (Option.isNone(url)) {
          return HttpServerResponse.text("Invalid WebSocket URL", { status: 400 });
        }

        // Origin/Host defense (anti-CSRF, anti-DNS-rebinding) as defense in depth.
        if (!auth.isAllowedUpgrade({ request, url: url.value })) {
          return HttpServerResponse.text("Cross-origin WebSocket connection rejected", {
            status: 403,
          });
        }

        // The real boundary: when remote-reachable, a valid principal (WS ticket,
        // session cookie, session bearer, or legacy token) is mandatory.
        const principal = auth.authenticateUpgrade({ request, url: url.value });
        if (auth.requireAuth && !principal) {
          return HttpServerResponse.text("Unauthorized WebSocket connection", { status: 401 });
        }

        return yield* rpcWebSocketHttpEffect;
      }),
    );
  }),
);
