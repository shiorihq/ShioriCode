import { chmodSync, existsSync, lstatSync } from "node:fs";
import { isIP } from "node:net";
import nodePath from "node:path";

import { Data, Effect, FileSystem, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { decodeServerInstanceRecord, encodeServerInstanceRecord } from "shared/serverInstance";

import { authRoutesLayer } from "./auth/authRoutes";
import {
  appearanceBackgroundFileRouteLayer,
  appearanceBackgroundUploadRouteLayer,
} from "./appearanceBackground";
import { EnvironmentAuthLive } from "./auth/EnvironmentAuth";
import { linkAccessRoutesLayer } from "./auth/linkAccessRoutes";
import { RemoteAccessLive, remoteHealthRouteLayer, SERVER_BOOT_ID } from "./remote/RemoteAccess";
import { hasPersistedLinkHostedAccess } from "./remote/linkStore";
import { linkAuthCallbackRouteLayer } from "./remote/linkAuthRoute";
import { RemoteStateStore } from "./remote/remoteStateStore";
import { avatarDeleteRouteLayer, avatarUploadRouteLayer } from "./avatarUpload";
import {
  BrowserPanelRequestsLive,
  browserPanelCommandRouteLayer,
  browserPanelRequestRouteLayer,
} from "./browserPanelRequests";
import { type ServerConfigShape, ServerConfig } from "./config";
import { attachmentsRouteLayer, projectFaviconRouteLayer, staticAndDevRouteLayer } from "./http";
import { mobileRoutesLayer } from "./mobile";
import { threadGoalControlRouteLayer } from "./threadGoalControl";
import { fixPath } from "./os-jank";
import { websocketRpcRouteLayer } from "./ws";
import { OpenLive } from "./open";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite";
import { writeFileStringAtomically } from "./persistence/writeFileStringAtomically";
import { ServerLifecycleEventsLive } from "./serverLifecycleEvents";
import { AnalyticsServiceLayerLive } from "./telemetry/Layers/AnalyticsService";
import { makeEventNdjsonLogger } from "./provider/Layers/EventNdjsonLogger";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory";
import { ProviderSessionRuntimeRepositoryLive } from "./persistence/Layers/ProviderSessionRuntime";
import { KimiCodeAdapterLive } from "./provider/Layers/KimiCodeAdapter";
import { makeGeminiAdapterLive } from "./provider/Layers/GeminiAdapter";
import { makeCursorAdapterLive } from "./provider/Layers/CursorAdapter";
import { makeCodexAdapterLive } from "./provider/Layers/CodexAdapter";
import { makeClaudeAdapterLive, makeGlmAdapterLive } from "./provider/Layers/ClaudeAdapter";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry";
import { makeProviderServiceLive } from "./provider/Layers/ProviderService";
import { ProviderSessionReaperLive } from "./provider/Layers/ProviderSessionReaper";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts";
import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore";
import { GitCoreLive } from "./git/Layers/GitCore";
import { GitHubCliLive } from "./git/Layers/GitHubCli";
import { RoutingTextGenerationLive } from "./git/Layers/RoutingTextGeneration";
import { TerminalManagerLive } from "./terminal/Layers/Manager";
import { GitManagerLive } from "./git/Layers/GitManager";
import { KeybindingsLive } from "./keybindings";
import { ServerLoggerLive } from "./serverLogger";
import { ServerRuntimeStartup, ServerRuntimeStartupLive } from "./serverRuntimeStartup";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor";
import { GoalPromptReactorLive } from "./orchestration/Layers/GoalPromptReactor";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor";
import { SubagentDetailQueryLive } from "./orchestration/Layers/SubagentDetailQuery";
import { ProviderRegistryLive } from "./provider/Layers/ProviderRegistry";
import { ServerSettingsLive } from "./serverSettings";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver";
import { WorkspaceEntriesLive } from "./workspace/Layers/WorkspaceEntries";
import { WorkspaceFileSystemLive } from "./workspace/Layers/WorkspaceFileSystem";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths";
import { ComputerUseManagerLive } from "./computer/Layers/MacOSComputerUseManager";
import { AutomationRepositoryLive } from "./automations/Layers/AutomationRepository";
import { AutomationServiceLive } from "./automations/Layers/AutomationService";

// Mobile snapshots may intentionally hold a request for up to 25 seconds.
// Bun defaults to 10 seconds, which aborts healthy long polls and makes the
// phone appear offline while the desktop server is still running.
const BUN_HTTP_IDLE_TIMEOUT_SECONDS = 35;

class ServerStartupStateError extends Data.TaggedError("ServerStartupStateError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const PtyAdapterLive = Layer.unwrap(
  Effect.gen(function* () {
    if (typeof Bun !== "undefined" && process.platform !== "win32") {
      const BunPTY = yield* Effect.promise(() => import("./terminal/Layers/BunPTY"));
      return BunPTY.layer;
    } else {
      const NodePTY = yield* Effect.promise(() => import("./terminal/Layers/NodePTY"));
      return NodePTY.layer;
    }
  }),
);

const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (typeof Bun !== "undefined") {
      const BunHttpServer = yield* Effect.promise(
        () => import("@effect/platform-bun/BunHttpServer"),
      );
      return BunHttpServer.layer({
        port: config.port,
        idleTimeout: BUN_HTTP_IDLE_TIMEOUT_SECONDS,
        ...(config.host ? { hostname: config.host } : {}),
      });
    } else {
      const [NodeHttpServer, NodeHttp] = yield* Effect.all([
        Effect.promise(() => import("@effect/platform-node/NodeHttpServer")),
        Effect.promise(() => import("node:http")),
      ]);
      return NodeHttpServer.layer(NodeHttp.createServer, {
        host: config.host,
        port: config.port,
      });
    }
  }),
);

const PlatformServicesLive = Layer.unwrap(
  Effect.gen(function* () {
    if (typeof Bun !== "undefined") {
      const { layer } = yield* Effect.promise(() => import("@effect/platform-bun/BunServices"));
      return layer;
    } else {
      const { layer } = yield* Effect.promise(() => import("@effect/platform-node/NodeServices"));
      return layer;
    }
  }),
);

const ReactorLayerLive = OrchestrationReactorLive.pipe(
  Layer.provideMerge(ProviderRuntimeIngestionLive),
  Layer.provideMerge(ProviderCommandReactorLive),
  Layer.provideMerge(CheckpointReactorLive),
  Layer.provideMerge(GoalPromptReactorLive),
  Layer.provideMerge(RuntimeReceiptBusLive),
);

const OrchestrationEventInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationEventStoreLive,
  OrchestrationCommandReceiptRepositoryLive,
);

const OrchestrationProjectionPipelineLayerLive = OrchestrationProjectionPipelineLive.pipe(
  Layer.provide(OrchestrationEventStoreLive),
);

const OrchestrationInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationProjectionSnapshotQueryLive,
  OrchestrationEventInfrastructureLayerLive,
  OrchestrationProjectionPipelineLayerLive,
);

const OrchestrationLayerLive = Layer.mergeAll(
  OrchestrationInfrastructureLayerLive,
  OrchestrationEngineLive.pipe(Layer.provide(OrchestrationInfrastructureLayerLive)),
);

const CheckpointingLayerLive = CheckpointDiffQueryLive.pipe(
  Layer.provideMerge(CheckpointStoreLive),
);

const ProviderSessionDirectoryLayerLive = ProviderSessionDirectoryLive.pipe(
  Layer.provide(ProviderSessionRuntimeRepositoryLive),
);

const ProviderLayerLive = Layer.unwrap(
  Effect.gen(function* () {
    const { providerEventLogPath } = yield* ServerConfig;
    const nativeEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "native",
    });
    const canonicalEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "canonical",
    });
    const kimiCodeAdapterLayer = KimiCodeAdapterLive;
    const geminiAdapterLayer = makeGeminiAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const glmAdapterLayer = makeGlmAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const cursorAdapterLayer = makeCursorAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const codexAdapterLayer = makeCodexAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const claudeAdapterLayer = makeClaudeAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const adapterRegistryLayer = ProviderAdapterRegistryLive.pipe(
      Layer.provide(kimiCodeAdapterLayer),
      Layer.provide(geminiAdapterLayer),
      Layer.provide(glmAdapterLayer),
      Layer.provide(cursorAdapterLayer),
      Layer.provide(codexAdapterLayer),
      Layer.provide(claudeAdapterLayer),
      Layer.provideMerge(ProviderSessionDirectoryLayerLive),
    );
    return makeProviderServiceLive(
      canonicalEventLogger ? { canonicalEventLogger } : undefined,
    ).pipe(Layer.provide(adapterRegistryLayer), Layer.provide(ProviderSessionDirectoryLayerLive));
  }),
);

const ProviderSessionReaperLayerLive = ProviderSessionReaperLive.pipe(
  Layer.provideMerge(ProviderLayerLive),
  Layer.provideMerge(ProviderSessionDirectoryLayerLive),
  Layer.provideMerge(OrchestrationLayerLive),
);

const PersistenceLayerLive = SqlitePersistenceLayerLive;

const GitLayerLive = GitManagerLive.pipe(
  Layer.provideMerge(RoutingTextGenerationLive),
  Layer.provideMerge(GitHubCliLive),
  Layer.provideMerge(GitCoreLive),
);

const TerminalLayerLive = TerminalManagerLive.pipe(Layer.provide(PtyAdapterLive));

const AutomationLayerLive = AutomationServiceLive.pipe(
  Layer.provideMerge(AutomationRepositoryLive),
  Layer.provideMerge(OrchestrationLayerLive),
);

const WorkspaceLayerLive = Layer.mergeAll(
  WorkspacePathsLive,
  WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive)),
  WorkspaceFileSystemLive.pipe(
    Layer.provide(WorkspacePathsLive),
    Layer.provide(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
  ),
);

const RuntimeServicesBaseLive = ServerRuntimeStartupLive.pipe(
  Layer.provideMerge(ReactorLayerLive),
  Layer.provideMerge(SubagentDetailQueryLive),
  Layer.provideMerge(CheckpointingLayerLive),
  Layer.provideMerge(OrchestrationLayerLive),
  Layer.provideMerge(ProviderLayerLive),
  Layer.provideMerge(ProviderSessionReaperLayerLive),
  Layer.provideMerge(GitLayerLive),
  Layer.provideMerge(TerminalLayerLive),
  Layer.provideMerge(AutomationLayerLive),
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provideMerge(KeybindingsLive),
  Layer.provideMerge(ProviderRegistryLive),
  Layer.provideMerge(ServerSettingsLive),
);

const RuntimeServicesLive = RuntimeServicesBaseLive.pipe(
  Layer.provideMerge(WorkspaceLayerLive),
  Layer.provideMerge(ProjectFaviconResolverLive),
  Layer.provideMerge(AnalyticsServiceLayerLive),
  Layer.provideMerge(OpenLive),
  Layer.provideMerge(ComputerUseManagerLive),
  Layer.provideMerge(ServerLifecycleEventsLive),
  Layer.provideMerge(RemoteAccessLive.pipe(Layer.provideMerge(EnvironmentAuthLive))),
);

export const makeRoutesLayer = Layer.mergeAll(
  attachmentsRouteLayer,
  appearanceBackgroundUploadRouteLayer,
  appearanceBackgroundFileRouteLayer,
  avatarUploadRouteLayer,
  avatarDeleteRouteLayer,
  browserPanelRequestRouteLayer,
  browserPanelCommandRouteLayer,
  authRoutesLayer,
  linkAccessRoutesLayer,
  remoteHealthRouteLayer,
  linkAuthCallbackRouteLayer,
  mobileRoutesLayer,
  threadGoalControlRouteLayer,
  projectFaviconRouteLayer,
  staticAndDevRouteLayer,
  websocketRpcRouteLayer,
);

/**
 * Signals HTTP-dependent startup work only after the routed application has
 * been installed on the listening server. Acquiring HttpServer alone is not a
 * sufficient readiness boundary: its socket can accept connections before
 * HttpRouter.serve attaches the request handler.
 */
export const withHttpRoutesReadySignal =
  (config: ServerConfigShape) =>
  <A, E, R>(servedRoutesLayer: Layer.Layer<A, E, R>) =>
    servedRoutesLayer.pipe(
      Layer.tap(() =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* HttpServer.HttpServer;
          const startup = yield* ServerRuntimeStartup;
          // This record can contain the live legacy bearer token. Do not make
          // the routed server ready unless its owner-only replacement was
          // published successfully; otherwise an old 0644 record could keep a
          // still-valid credential readable while the new server is online.
          yield* writeServerInstanceRecord(fs, config);
          yield* Effect.addFinalizer(() =>
            clearServerInstanceRecord(fs, config).pipe(
              Effect.catch(() =>
                Effect.logWarning("failed to clear server instance record", {
                  path: config.serverInstancePath,
                }),
              ),
            ),
          );
          yield* startup.markHttpRoutesReady;
        }),
      ),
    );

export const makeServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;

    // Run before HttpServerLive is even constructed. HttpRouter.serve's tap is
    // intentionally a post-listen readiness boundary, so doing this there
    // would leave a brief upgrade window where a legacy 0644 token record and
    // live routes coexist.
    yield* Effect.try({
      try: () => hardenExistingServerInstanceRecordBeforeListen(config.serverInstancePath),
      catch: (cause) =>
        new ServerStartupStateError({
          message:
            cause instanceof Error
              ? cause.message
              : "Could not harden the existing server instance record",
          cause,
        }),
    });

    // Fail-closed gate: if the server is remote-reachable, it must have a way to
    // authenticate clients. Keyed on exposure intent (config.requireAuth), not on
    // the bind host, because a reverse proxy keeps the bind on loopback.
    if (config.requireAuth && !config.unsafeNoAuth) {
      const authConfigured = yield* Effect.try({
        try: () => hasConfiguredStartupAuthentication(config),
        catch: (cause) =>
          new ServerStartupStateError({
            message:
              cause instanceof Error
                ? cause.message
                : "Could not verify the configured authentication state",
            cause,
          }),
      });
      if (!authConfigured) {
        return yield* Effect.fail(
          new Error(
            "Refusing to start: remote access is enabled but no credentials are configured. " +
              "Set SHIORICODE_USERNAME and SHIORICODE_PASSWORD (persisted on first run), pass --auth-token, " +
              "connect ShioriCode Link, or pass --unsafe-no-auth to override (dangerous).",
          ),
        );
      }
    }

    fixPath();

    const serverApplicationLayer = HttpRouter.serve(makeRoutesLayer, {
      disableLogger: !config.logWebSocketEvents,
    }).pipe(Layer.provide(BrowserPanelRequestsLive), withHttpRoutesReadySignal(config));

    return serverApplicationLayer.pipe(
      Layer.provideMerge(RuntimeServicesLive),
      Layer.provideMerge(HttpServerLive),
      Layer.provide(ServerLoggerLive),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(PlatformServicesLive),
    );
  }),
);

export function hasConfiguredStartupAuthentication(
  config: ServerConfigShape,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (
    existsSync(nodePath.join(config.stateDir, "credentials.json")) ||
    Boolean(environment.SHIORICODE_USERNAME && environment.SHIORICODE_PASSWORD) ||
    Boolean(config.authToken)
  ) {
    return true;
  }
  const remoteState = new RemoteStateStore({ stateDir: config.stateDir });
  return (
    remoteState.method === "shiori-link" &&
    !remoteState.needsCleanup &&
    hasPersistedLinkHostedAccess(config.stateDir)
  );
}

// Important: Only `ServerConfig` should be provided by the CLI layer.
const RunServerDependencies = ServerSettingsLive;

export const runServer = Layer.launch(makeServerLayer).pipe(Effect.provide(RunServerDependencies));

export function buildServerInstanceUrl(config: ServerConfigShape) {
  const configuredHost =
    config.host && config.host !== "0.0.0.0" && config.host !== "::" && config.host !== "[::]"
      ? config.host
      : "127.0.0.1";
  const unbracketedHost = configuredHost.replace(/^\[/, "").replace(/\]$/, "");
  const host = isIP(unbracketedHost) === 6 ? `[${unbracketedHost}]` : configuredHost;
  const url = new URL(`ws://${host}:${config.port}/ws`);
  if (config.authToken) {
    url.searchParams.set("token", config.authToken);
  }
  return url.toString();
}

export function hardenExistingServerInstanceRecordBeforeListen(recordPath: string): void {
  try {
    const stat = lstatSync(recordPath);
    if (!stat.isFile()) {
      throw new Error(`Refusing to use a non-file server instance record: ${recordPath}`);
    }
    chmodSync(recordPath, 0o600);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
}

export const writeServerInstanceRecord = (fs: FileSystem.FileSystem, config: ServerConfigShape) =>
  Effect.gen(function* () {
    // Harden a record written by an older release before attempting the atomic
    // replacement. If the replacement later fails, startup also fails and the
    // legacy credential is no longer left world-readable.
    if (yield* fs.exists(config.serverInstancePath)) {
      yield* fs.chmod(config.serverInstancePath, 0o600);
    }
    const contents = yield* Effect.try({
      try: () =>
        `${JSON.stringify(
          encodeServerInstanceRecord({
            version: 1,
            pid: process.pid,
            port: config.port,
            baseDir: config.baseDir,
            startedAt: new Date().toISOString(),
            bootId: SERVER_BOOT_ID,
            wsUrl: buildServerInstanceUrl(config),
            authToken: config.authToken ?? null,
            launcher: config.mode,
          }),
          null,
          2,
        )}\n`,
      catch: (cause) =>
        new ServerStartupStateError({
          message:
            cause instanceof Error ? cause.message : "Could not encode server instance record",
          cause,
        }),
    });
    yield* writeFileStringAtomically(config.serverInstancePath, contents, { mode: 0o600 }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    );
  });

export const clearServerInstanceRecord = (fs: FileSystem.FileSystem, config: ServerConfigShape) =>
  Effect.gen(function* () {
    const exists = yield* fs.exists(config.serverInstancePath);
    if (!exists) {
      return;
    }
    const raw = yield* fs.readFileString(config.serverInstancePath);
    const current = yield* Effect.try({
      try: () => decodeServerInstanceRecord(JSON.parse(raw)),
      catch: (cause) =>
        new ServerStartupStateError({
          message:
            cause instanceof Error ? cause.message : "Could not decode server instance record",
          cause,
        }),
    }).pipe(
      Effect.catch(() =>
        fs.remove(config.serverInstancePath, { force: true }).pipe(Effect.as(null)),
      ),
    );
    if (current === null) {
      return;
    }
    if (current.pid !== process.pid) {
      return;
    }
    yield* fs.remove(config.serverInstancePath);
  });
