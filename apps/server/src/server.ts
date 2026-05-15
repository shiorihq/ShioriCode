import { Effect, FileSystem, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { decodeServerInstanceRecord, encodeServerInstanceRecord } from "shared/serverInstance";

import { avatarDeleteRouteLayer, avatarUploadRouteLayer } from "./avatarUpload";
import {
  BrowserPanelRequestsLive,
  browserPanelCommandRouteLayer,
  browserPanelRequestRouteLayer,
} from "./browserPanelRequests";
import { type ServerConfigShape, ServerConfig } from "./config";
import { attachmentsRouteLayer, projectFaviconRouteLayer, staticAndDevRouteLayer } from "./http";
import { mobileRoutesLayer } from "./mobile";
import { fixPath } from "./os-jank";
import { websocketRpcRouteLayer } from "./ws";
import { OpenLive } from "./open";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite";
import { ServerLifecycleEventsLive } from "./serverLifecycleEvents";
import { AnalyticsServiceLayerLive } from "./telemetry/Layers/AnalyticsService";
import { makeEventNdjsonLogger } from "./provider/Layers/EventNdjsonLogger";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory";
import { ProviderSessionRuntimeRepositoryLive } from "./persistence/Layers/ProviderSessionRuntime";
import { ShioriAdapterLive } from "./provider/Layers/ShioriAdapter";
import { KimiCodeAdapterLive } from "./provider/Layers/KimiCodeAdapter";
import { makeGeminiAdapterLive } from "./provider/Layers/GeminiAdapter";
import { makeCursorAdapterLive } from "./provider/Layers/CursorAdapter";
import { makeCodexAdapterLive } from "./provider/Layers/CodexAdapter";
import { makeClaudeAdapterLive } from "./provider/Layers/ClaudeAdapter";
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
import { ShioriProviderLive } from "./provider/Layers/ShioriProvider";
import { ServerSettingsLive } from "./serverSettings";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver";
import { WorkspaceEntriesLive } from "./workspace/Layers/WorkspaceEntries";
import { WorkspaceFileSystemLive } from "./workspace/Layers/WorkspaceFileSystem";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths";
import { HostedShioriAuthTokenStoreLive } from "./hostedShioriAuthTokenStore";
import { HostedBillingLive } from "./hostedBilling";
import { ComputerUseManagerLive } from "./computer/Layers/MacOSComputerUseManager";

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
    const shioriAdapterLayer = ShioriAdapterLive.pipe(
      Layer.provide(ProviderSessionDirectoryLayerLive),
    );
    const kimiCodeAdapterLayer = KimiCodeAdapterLive;
    const geminiAdapterLayer = makeGeminiAdapterLive(
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
      Layer.provide(shioriAdapterLayer),
      Layer.provide(kimiCodeAdapterLayer),
      Layer.provide(geminiAdapterLayer),
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
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provideMerge(KeybindingsLive),
  Layer.provideMerge(ShioriProviderLive),
  Layer.provideMerge(ProviderRegistryLive),
  Layer.provideMerge(ServerSettingsLive),
  Layer.provideMerge(HostedShioriAuthTokenStoreLive),
  Layer.provideMerge(HostedBillingLive),
);

const RuntimeServicesLive = RuntimeServicesBaseLive.pipe(
  Layer.provideMerge(WorkspaceLayerLive),
  Layer.provideMerge(ProjectFaviconResolverLive),
  Layer.provideMerge(AnalyticsServiceLayerLive),
  Layer.provideMerge(OpenLive),
  Layer.provideMerge(ComputerUseManagerLive),
  Layer.provideMerge(ServerLifecycleEventsLive),
);

export const makeRoutesLayer = Layer.mergeAll(
  attachmentsRouteLayer,
  avatarUploadRouteLayer,
  avatarDeleteRouteLayer,
  browserPanelRequestRouteLayer,
  browserPanelCommandRouteLayer,
  mobileRoutesLayer,
  projectFaviconRouteLayer,
  staticAndDevRouteLayer,
  websocketRpcRouteLayer,
);

export const makeServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;

    fixPath();

    const httpListeningLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* HttpServer.HttpServer;
        const startup = yield* ServerRuntimeStartup;
        yield* startup.markHttpListening;
        yield* writeServerInstanceRecord(fs, config).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("failed to write server instance record", {
              path: config.serverInstancePath,
              cause,
            }),
          ),
        );
        yield* Effect.addFinalizer(() =>
          clearServerInstanceRecord(fs, config).pipe(
            Effect.catch(() =>
              Effect.logWarning("failed to clear server instance record", {
                path: config.serverInstancePath,
              }),
            ),
          ),
        );
      }),
    );

    const serverApplicationLayer = Layer.mergeAll(
      HttpRouter.serve(makeRoutesLayer, {
        disableLogger: !config.logWebSocketEvents,
      }).pipe(Layer.provide(BrowserPanelRequestsLive)),
      httpListeningLayer,
    );

    return serverApplicationLayer.pipe(
      Layer.provideMerge(RuntimeServicesLive),
      Layer.provideMerge(HttpServerLive),
      Layer.provide(ServerLoggerLive),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(PlatformServicesLive),
    );
  }),
);

// Important: Only `ServerConfig` should be provided by the CLI layer.
const RunServerDependencies = Layer.mergeAll(ServerSettingsLive, HostedShioriAuthTokenStoreLive);

export const runServer = Layer.launch(makeServerLayer).pipe(Effect.provide(RunServerDependencies));

function buildServerInstanceUrl(config: ServerConfigShape) {
  const host =
    config.host && config.host !== "0.0.0.0" && config.host !== "::" && config.host !== "[::]"
      ? config.host
      : "127.0.0.1";
  const url = new URL(`ws://${host}:${config.port}/ws`);
  if (config.authToken) {
    url.searchParams.set("token", config.authToken);
  }
  return url.toString();
}

const writeServerInstanceRecord = (fs: FileSystem.FileSystem, config: ServerConfigShape) =>
  fs.writeFileString(
    config.serverInstancePath,
    `${JSON.stringify(
      encodeServerInstanceRecord({
        version: 1,
        pid: process.pid,
        port: config.port,
        baseDir: config.baseDir,
        startedAt: new Date().toISOString(),
        wsUrl: buildServerInstanceUrl(config),
        authToken: config.authToken ?? null,
        launcher: config.mode,
      }),
      null,
      2,
    )}\n`,
  );

const clearServerInstanceRecord = (fs: FileSystem.FileSystem, config: ServerConfigShape) =>
  Effect.gen(function* () {
    const exists = yield* fs.exists(config.serverInstancePath);
    if (!exists) {
      return;
    }
    const raw = yield* fs.readFileString(config.serverInstancePath);
    const current = decodeServerInstanceRecord(JSON.parse(raw));
    if (current.pid !== process.pid) {
      return;
    }
    yield* fs.remove(config.serverInstancePath);
  });
