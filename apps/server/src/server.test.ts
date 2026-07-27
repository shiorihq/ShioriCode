import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  KeybindingRule,
  OpenError,
  TerminalNotRunningError,
  type OrchestrationEvent,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ResolvedKeybindingRule,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
  EditorId,
} from "contracts";
import { assert, it } from "@effect/vitest";
import { assertFailure, assertInclude, assertTrue } from "@effect/vitest/utils";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";
import { HttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";

import type { ServerConfigShape } from "./config.ts";
import { deriveServerPaths, ServerConfig } from "./config.ts";
import { makeRoutesLayer, withHttpRoutesReadySignal } from "./server.ts";
import { EnvironmentAuthLive } from "./auth/EnvironmentAuth";
import { RemoteAccessLive } from "./remote/RemoteAccess";
import { resolveAttachmentRelativePath } from "./attachmentPaths.ts";
import {
  CheckpointDiffQuery,
  type CheckpointDiffQueryShape,
} from "./checkpointing/Services/CheckpointDiffQuery.ts";
import { GitCore, type GitCoreShape } from "./git/Services/GitCore.ts";
import { GitManager, type GitManagerShape } from "./git/Services/GitManager.ts";
import { Keybindings, type KeybindingsShape } from "./keybindings.ts";
import { Open, type OpenShape } from "./open.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  SubagentDetailQuery,
  type SubagentDetailQueryShape,
} from "./orchestration/Services/SubagentDetailQuery.ts";
import {
  ProviderRegistry,
  type ProviderRegistryShape,
} from "./provider/Services/ProviderRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "./provider/Services/ProviderService.ts";
import { ServerLifecycleEvents, type ServerLifecycleEventsShape } from "./serverLifecycleEvents.ts";
import { ServerRuntimeStartup, type ServerRuntimeStartupShape } from "./serverRuntimeStartup.ts";
import { ServerSettingsService, type ServerSettingsShape } from "./serverSettings.ts";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import { TerminalManager, type TerminalManagerShape } from "./terminal/Services/Manager.ts";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver.ts";
import { WorkspaceEntriesLive } from "./workspace/Layers/WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "./workspace/Layers/WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths.ts";
import { BrowserPanelRequestsLive } from "./browserPanelRequests.ts";
import {
  ComputerUseManager,
  type ComputerUseManagerShape,
} from "./computer/Services/ComputerUseManager.ts";
import {
  AutomationService,
  type AutomationServiceShape,
} from "./automations/Services/AutomationService.ts";

const defaultProjectId = ProjectId.makeUnsafe("project-default");
const defaultThreadId = ThreadId.makeUnsafe("thread-default");
const defaultModelSelection = {
  provider: "codex",
  model: "gpt-5-codex",
} as const;

const makeDefaultOrchestrationReadModel = () => {
  const now = new Date().toISOString();
  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [
      {
        id: defaultProjectId,
        title: "Default Project",
        workspaceRoot: "/tmp/default-project",
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: defaultThreadId,
        projectId: defaultProjectId,
        title: "Default Thread",
        modelSelection: defaultModelSelection,
        interactionMode: "default" as const,
        runtimeMode: "full-access" as const,
        parentThreadId: null,
        branchSourceTurnId: null,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        latestTurn: null,
        messages: [],
        session: null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  };
};

const workspaceAndProjectServicesLayer = Layer.mergeAll(
  WorkspacePathsLive,
  WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive)),
  WorkspaceFileSystemLive.pipe(
    Layer.provide(WorkspacePathsLive),
    Layer.provide(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
  ),
  ProjectFaviconResolverLive,
);

const buildAppUnderTest = (options?: {
  config?: Partial<ServerConfigShape>;
  layers?: {
    keybindings?: Partial<KeybindingsShape>;
    providerRegistry?: Partial<ProviderRegistryShape>;
    providerService?: Partial<ProviderServiceShape>;
    serverSettings?: Partial<ServerSettingsShape>;
    open?: Partial<OpenShape>;
    gitCore?: Partial<GitCoreShape>;
    gitManager?: Partial<GitManagerShape>;
    terminalManager?: Partial<TerminalManagerShape>;
    orchestrationEngine?: Partial<OrchestrationEngineShape>;
    projectionSnapshotQuery?: Partial<ProjectionSnapshotQueryShape>;
    subagentDetailQuery?: Partial<SubagentDetailQueryShape>;
    checkpointDiffQuery?: Partial<CheckpointDiffQueryShape>;
    serverLifecycleEvents?: Partial<ServerLifecycleEventsShape>;
    serverRuntimeStartup?: Partial<ServerRuntimeStartupShape>;
    computerUseManager?: Partial<ComputerUseManagerShape>;
    automationService?: Partial<AutomationServiceShape>;
  };
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const tempBaseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-test-" });
    const baseDir = options?.config?.baseDir ?? tempBaseDir;
    const devUrl = options?.config?.devUrl;
    const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
    const config = {
      logLevel: "Info",
      mode: "web",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl,
      noBrowser: true,
      authToken: undefined,
      requireAuth: false,
      unsafeNoAuth: false,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      ...options?.config,
    } satisfies ServerConfigShape;
    const layerConfig = Layer.succeed(ServerConfig, config);
    const computerUseManagerLayer = Layer.mock(ComputerUseManager)({
      getPermissions: Effect.die("unused"),
      requestPermission: () => Effect.die("unused"),
      showPermissionGuide: () => Effect.die("unused"),
      createSession: Effect.die("unused"),
      closeSession: () => Effect.die("unused"),
      screenshot: () => Effect.die("unused"),
      listApps: () => Effect.die("unused"),
      focusApp: () => Effect.die("unused"),
      focusWindow: () => Effect.die("unused"),
      click: () => Effect.die("unused"),
      doubleClick: () => Effect.die("unused"),
      rightClick: () => Effect.die("unused"),
      move: () => Effect.die("unused"),
      drag: () => Effect.die("unused"),
      type: () => Effect.die("unused"),
      key: () => Effect.die("unused"),
      scroll: () => Effect.die("unused"),
      wait: () => Effect.die("unused"),
      ...options?.layers?.computerUseManager,
    });

    const appLayerBase = HttpRouter.serve(makeRoutesLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      withHttpRoutesReadySignal(config),
      Layer.provide(
        Layer.mock(Keybindings)({
          streamChanges: Stream.empty,
          ...options?.layers?.keybindings,
        }),
      ),
      Layer.provide(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([]),
          refresh: () => Effect.succeed([]),
          streamChanges: Stream.empty,
          ...options?.layers?.providerRegistry,
        }),
      ),
      Layer.provide(
        Layer.mock(ProviderService)({
          startSession: () => Effect.die("unused"),
          sendTurn: () => Effect.die("unused"),
          steerTurn: () => Effect.die("unused"),
          interruptTurn: () => Effect.die("unused"),
          respondToRequest: () => Effect.die("unused"),
          respondToUserInput: () => Effect.die("unused"),
          stopSession: () => Effect.die("unused"),
          listSessions: () => Effect.succeed([]),
          getCapabilities: () => Effect.die("unused"),
          readUsage: () => Effect.die("unused"),
          rollbackConversation: () => Effect.die("unused"),
          streamEvents: Stream.empty,
          ...options?.layers?.providerService,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerSettingsService)({
          start: Effect.void,
          ready: Effect.void,
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
          streamChanges: Stream.empty,
          ...options?.layers?.serverSettings,
        }),
      ),
      Layer.provide(
        Layer.mock(AnalyticsService)({
          record: () => Effect.void,
          flush: Effect.void,
        }),
      ),
      Layer.provide(
        Layer.mock(Open)({
          ...options?.layers?.open,
        }),
      ),
      Layer.provide(
        Layer.mock(GitCore)({
          ...options?.layers?.gitCore,
        }),
      ),
      Layer.provide(
        Layer.mock(GitManager)({
          ...options?.layers?.gitManager,
        }),
      ),
      Layer.provide(
        Layer.mock(TerminalManager)({
          ...options?.layers?.terminalManager,
        }),
      ),
      Layer.provide(
        Layer.mock(OrchestrationEngineService)({
          getReadModel: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
          readEvents: () => Stream.empty,
          dispatch: () => Effect.succeed({ sequence: 0 }),
          streamDomainEvents: Stream.empty,
          ...options?.layers?.orchestrationEngine,
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery)({
          getSnapshot: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
          ...options?.layers?.projectionSnapshotQuery,
        }),
      ),
      Layer.provide(
        Layer.mock(SubagentDetailQuery)({
          getSubagentDetail: () => Effect.die("unused"),
          ...options?.layers?.subagentDetailQuery,
        }),
      ),
      Layer.provide(
        Layer.mock(CheckpointDiffQuery)({
          getTurnDiff: () =>
            Effect.succeed({
              threadId: defaultThreadId,
              fromTurnCount: 0,
              toTurnCount: 0,
              diff: "",
            }),
          getFullThreadDiff: () =>
            Effect.succeed({
              threadId: defaultThreadId,
              fromTurnCount: 0,
              toTurnCount: 0,
              diff: "",
            }),
          ...options?.layers?.checkpointDiffQuery,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerLifecycleEvents)({
          publish: (event) => Effect.succeed({ ...(event as any), sequence: 1 }),
          snapshot: Effect.succeed({ sequence: 0, events: [] }),
          stream: Stream.empty,
          ...options?.layers?.serverLifecycleEvents,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerRuntimeStartup)({
          awaitCommandReady: Effect.void,
          markHttpRoutesReady: Effect.void,
          enqueueCommand: (effect) => effect,
          ...options?.layers?.serverRuntimeStartup,
        }),
      ),
    );

    const appLayer = appLayerBase.pipe(
      Layer.provide(
        Layer.mock(AutomationService)({
          list: Effect.succeed({ automations: [] }),
          create: () => Effect.succeed({ automations: [] }),
          update: () => Effect.succeed({ automations: [] }),
          delete: () => Effect.succeed({ automations: [] }),
          runNow: () => Effect.succeed({ automations: [] }),
          start: Effect.void,
          ...options?.layers?.automationService,
        }),
      ),
      Layer.provide(Layer.mergeAll(BrowserPanelRequestsLive, computerUseManagerLayer)),
      Layer.provide(workspaceAndProjectServicesLayer),
      Layer.provide(RemoteAccessLive.pipe(Layer.provideMerge(EnvironmentAuthLive))),
      Layer.provide(layerConfig),
    );

    yield* Layer.build(appLayer);
    return config;
  });

const wsRpcProtocolLayer = (wsUrl: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(NodeSocket.layerWebSocket(wsUrl)),
    Layer.provide(RpcSerialization.layerJson),
  );

const makeWsRpcClient = RpcClient.make(WsRpcGroup);
type WsRpcClient =
  typeof makeWsRpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

const withWsRpcClient = <A, E, R>(
  wsUrl: string,
  f: (client: WsRpcClient) => Effect.Effect<A, E, R>,
) => makeWsRpcClient.pipe(Effect.flatMap(f), Effect.provide(wsRpcProtocolLayer(wsUrl)));

const getHttpServerUrl = (pathname = "") =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    return `http://127.0.0.1:${address.port}${pathname}`;
  });

const getWsServerUrl = (pathname = "") =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    return `ws://127.0.0.1:${address.port}${pathname}`;
  });

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("serves static index content for GET / when staticDir is configured", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-static-" });
      const indexPath = path.join(staticDir, "index.html");
      yield* fileSystem.writeFileString(indexPath, "<html>router-static-ok</html>");

      yield* buildAppUnderTest({ config: { staticDir } });

      const response = yield* HttpClient.get("/");
      assert.equal(response.status, 200);
      assert.include(yield* response.text, "router-static-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("signals HTTP readiness only after the routed application can respond", () =>
    Effect.gen(function* () {
      let readinessSignals = 0;

      yield* buildAppUnderTest({
        layers: {
          serverRuntimeStartup: {
            markHttpRoutesReady: Effect.sync(() => {
              readinessSignals += 1;
            }),
          },
        },
      });

      assert.equal(readinessSignals, 1);
      const url = yield* getHttpServerUrl("/api/internal/thread-goal");
      const routeStatus = yield* Effect.promise(async () => {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Connection: "close",
            "Content-Type": "application/json",
          },
          body: "{}",
          signal: AbortSignal.timeout(1_000),
        });
        await response.text();
        return response.status;
      });
      assert.equal(routeStatus, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("proxies the requested path to the dev URL without leaking loopback redirects", () =>
    Effect.gen(function* () {
      const upstream = createServer((request, response) => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ url: request.url }));
      });
      yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              upstream.once("error", reject);
              upstream.listen(0, "127.0.0.1", resolve);
            }),
        ),
        () =>
          Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                upstream.close((error) => (error ? reject(error) : resolve()));
              }),
          ),
      );
      const upstreamAddress = upstream.address() as AddressInfo;
      yield* buildAppUnderTest({
        config: { devUrl: new URL(`http://127.0.0.1:${upstreamAddress.port}`) },
      });

      const url = yield* getHttpServerUrl("/foo/bar?theme=dark");
      const response = yield* Effect.promise(() => fetch(url));

      assert.equal(response.status, 200);
      assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
        url: "/foo/bar?theme=dark",
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves project favicon requests before the dev URL redirect", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-router-project-favicon-",
      });
      yield* fileSystem.writeFileString(
        path.join(projectDir, "favicon.svg"),
        "<svg>router-project-favicon</svg>",
      );

      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
      });

      const response = yield* HttpClient.get(
        `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`,
      );

      assert.equal(response.status, 200);
      assert.equal(yield* response.text, "<svg>router-project-favicon</svg>");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves the fallback project favicon when no icon exists", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const projectDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-router-project-favicon-fallback-",
      });

      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
      });

      const response = yield* HttpClient.get(
        `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`,
      );

      assert.equal(response.status, 200);
      assert.include(yield* response.text, 'data-fallback="project-favicon"');
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves attachment files from state dir", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-11111111-1111-4111-8111-111111111111";

      const config = yield* buildAppUnderTest();
      const attachmentPath = resolveAttachmentRelativePath({
        attachmentsDir: config.attachmentsDir,
        relativePath: `${attachmentId}.bin`,
      });
      assert.isNotNull(attachmentPath, "Attachment path should be resolvable");

      yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true });
      yield* fileSystem.writeFileString(attachmentPath, "attachment-ok");

      const response = yield* HttpClient.get(`/attachments/${attachmentId}`);
      assert.equal(response.status, 200);
      assert.equal(yield* response.text, "attachment-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("stores and serves a custom appearance background from the host state directory", () =>
    Effect.gen(function* () {
      const config = yield* buildAppUnderTest();
      const uploadUrl = yield* getHttpServerUrl("/api/appearance/background");
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const uploadResponse = yield* Effect.promise(async () => {
        const formData = new FormData();
        formData.append("file", new File([pngBytes], "background.png", { type: "image/png" }));
        return fetch(uploadUrl, { method: "POST", body: formData });
      });

      const uploadText = yield* Effect.promise(() => uploadResponse.text());
      assert.equal(uploadResponse.status, 200, uploadText);
      const uploadBody = JSON.parse(uploadText) as {
        data: { version: string };
        success: boolean;
      };
      assert.isTrue(uploadBody.success);
      assert.match(uploadBody.data.version, /^[0-9a-f-]{36}$/i);

      const savedPath = `${config.appearanceBackgroundsDir}/custom-${uploadBody.data.version}.png`;
      const savedBytes = yield* (yield* FileSystem.FileSystem).readFile(savedPath);
      assert.deepEqual([...savedBytes], [...pngBytes]);

      const imageUrl = yield* getHttpServerUrl(
        `/api/appearance/background/${uploadBody.data.version}`,
      );
      const imageResponse = yield* Effect.promise(() => fetch(imageUrl));
      assert.equal(imageResponse.status, 200);
      assert.deepEqual(
        [...new Uint8Array(yield* Effect.promise(() => imageResponse.arrayBuffer()))],
        [...pngBytes],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("requires an authenticated owner before creating a mobile pairing secret", () =>
    Effect.gen(function* () {
      const previousUsername = process.env.SHIORICODE_USERNAME;
      const previousPassword = process.env.SHIORICODE_PASSWORD;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.env.SHIORICODE_USERNAME = "mobile-owner";
          process.env.SHIORICODE_PASSWORD = "correct horse battery staple";
        }),
        () =>
          Effect.sync(() => {
            if (previousUsername === undefined) delete process.env.SHIORICODE_USERNAME;
            else process.env.SHIORICODE_USERNAME = previousUsername;
            if (previousPassword === undefined) delete process.env.SHIORICODE_PASSWORD;
            else process.env.SHIORICODE_PASSWORD = previousPassword;
          }),
      );

      yield* buildAppUnderTest({
        config: { requireAuth: true, authToken: undefined },
        layers: {
          serverSettings: {
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              mobileApp: { enabled: true },
            }),
          },
        },
      });
      const pairingUrl = yield* getHttpServerUrl("/api/mobile/pairing-sessions");

      const denied = yield* Effect.promise(() => fetch(pairingUrl, { method: "POST" }));
      assert.equal(denied.status, 401);
      assert.notInclude(yield* Effect.promise(() => denied.text()), "pairingSecret");

      const loginUrl = yield* getHttpServerUrl("/api/auth/login");
      const login = yield* Effect.promise(() =>
        fetch(loginUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: "mobile-owner",
            password: "correct horse battery staple",
          }),
        }),
      );
      assert.equal(login.status, 200);
      assert.match(login.headers.get("set-cookie") ?? "", /(?:^|;)\s*Secure(?:;|$)/i);
      const loginBody = (yield* Effect.promise(() => login.json())) as {
        token: string;
      };

      const allowed = yield* Effect.promise(() =>
        fetch(pairingUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${loginBody.token}` },
        }),
      );
      assert.equal(allowed.status, 200);
      const allowedBody = (yield* Effect.promise(() => allowed.json())) as {
        data: { qrPayload: string };
      };
      const qrPayload = JSON.parse(allowedBody.data.qrPayload) as { pairingSecret?: string };
      assert.isString(qrPayload.pairingSecret);

      const logoutUrl = yield* getHttpServerUrl("/api/auth/logout");
      const logout = yield* Effect.promise(() =>
        fetch(logoutUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${loginBody.token}` },
        }),
      );
      assert.equal(logout.status, 200);
      assert.match(logout.headers.get("set-cookie") ?? "", /(?:^|;)\s*Secure(?:;|$)/i);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("compares the legacy mobile pairing token through the shared auth boundary", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: { requireAuth: true, authToken: "legacy-secret" },
        layers: {
          serverSettings: {
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              mobileApp: { enabled: true },
            }),
          },
        },
      });
      const pairingUrl = yield* getHttpServerUrl("/api/mobile/pairing-sessions");

      const denied = yield* Effect.promise(() =>
        fetch(pairingUrl, {
          method: "POST",
          headers: { Authorization: "Bearer legacy-secrex" },
        }),
      );
      assert.equal(denied.status, 401);

      const allowed = yield* Effect.promise(() =>
        fetch(pairingUrl, {
          method: "POST",
          headers: { Authorization: "Bearer legacy-secret" },
        }),
      );
      assert.equal(allowed.status, 200);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("protects avatar upload and deletion before parsing attacker input", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: { requireAuth: true, authToken: "avatar-secret" },
      });
      const avatarUrl = yield* getHttpServerUrl("/api/profile/avatar");

      const deniedUpload = yield* Effect.promise(() => fetch(avatarUrl, { method: "POST" }));
      assert.equal(deniedUpload.status, 401);
      const deniedDelete = yield* Effect.promise(() => fetch(avatarUrl, { method: "DELETE" }));
      assert.equal(deniedDelete.status, 401);

      const allowedUpload = yield* Effect.promise(() =>
        fetch(avatarUrl, {
          method: "POST",
          headers: { Authorization: "Bearer avatar-secret" },
        }),
      );
      assert.equal(allowedUpload.status, 400);

      const allowedDelete = yield* Effect.promise(() =>
        fetch(avatarUrl, {
          method: "DELETE",
          headers: {
            Authorization: "Bearer avatar-secret",
            "Content-Type": "application/json",
          },
          body: "{}",
        }),
      );
      assert.equal(allowedDelete.status, 200);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns 400 for blank mobile identifiers and persists devices atomically", () =>
    Effect.gen(function* () {
      const config = yield* buildAppUnderTest({
        config: { requireAuth: true, authToken: "mobile-secret" },
        layers: {
          serverSettings: {
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              mobileApp: { enabled: true },
            }),
          },
        },
      });
      const pairingUrl = yield* getHttpServerUrl("/api/mobile/pairing-sessions");
      const pairUrl = yield* getHttpServerUrl("/api/mobile/pair");
      const pairedDevices = yield* Effect.promise(async () => {
        const sessions = await Promise.all(
          Array.from({ length: 8 }, async () => {
            const response = await fetch(pairingUrl, {
              method: "POST",
              headers: { Authorization: "Bearer mobile-secret" },
            });
            assert.equal(response.status, 200);
            const body = (await response.json()) as {
              data: { pairingId: string; qrPayload: string };
            };
            const payload = JSON.parse(body.data.qrPayload) as { pairingSecret: string };
            return { pairingId: body.data.pairingId, pairingSecret: payload.pairingSecret };
          }),
        );
        return Promise.all(
          sessions.map(async (session, index) => {
            const response = await fetch(pairUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ...session,
                deviceName: `Security regression iPhone ${index}`,
              }),
            });
            assert.equal(response.status, 200);
            return (await response.json()) as {
              data: { deviceId: string; token: string };
            };
          }),
        );
      });
      const pairBody = pairedDevices[0];
      assert.isDefined(pairBody);
      const mobileHeaders = {
        Authorization: `Bearer ${pairBody.data.token}`,
        "x-shioricode-device-id": pairBody.data.deviceId,
      };

      const commandUrl = yield* getHttpServerUrl("/api/mobile/commands");
      const invalidRequestId = yield* Effect.promise(() =>
        fetch(commandUrl, {
          method: "POST",
          headers: { ...mobileHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "thread.archive",
            requestId: "   ",
            threadId: "thread-default",
          }),
        }),
      );
      assert.equal(invalidRequestId.status, 400);
      assert.include(
        yield* Effect.promise(() => invalidRequestId.text()),
        "Invalid mobile command",
      );

      const validCommand = yield* Effect.promise(() =>
        fetch(commandUrl, {
          method: "POST",
          headers: { ...mobileHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "thread.archive",
            requestId: "request-1",
            threadId: "missing-thread",
          }),
        }),
      );
      const validCommandBody = yield* Effect.promise(() => validCommand.text());
      assert.equal(validCommand.status, 400, validCommandBody);
      assert.include(validCommandBody, "Thread not found");

      const invalidThreadUrl = yield* getHttpServerUrl("/api/mobile/thread/diff?threadId=%20%20");
      const invalidThread = yield* Effect.promise(() =>
        fetch(invalidThreadUrl, { headers: mobileHeaders }),
      );
      assert.equal(invalidThread.status, 400);
      assert.include(yield* Effect.promise(() => invalidThread.text()), "Invalid threadId");

      const validThreadUrl = yield* getHttpServerUrl(
        "/api/mobile/thread/diff?threadId=thread-default",
      );
      const validThread = yield* Effect.promise(() =>
        fetch(validThreadUrl, { headers: mobileHeaders }),
      );
      assert.equal(validThread.status, 200);

      const invalidProjectUrl = yield* getHttpServerUrl(
        "/api/mobile/workspace/entries?projectId=%20%20",
      );
      const invalidProject = yield* Effect.promise(() =>
        fetch(invalidProjectUrl, { headers: mobileHeaders }),
      );
      assert.equal(invalidProject.status, 400);
      assert.include(yield* Effect.promise(() => invalidProject.text()), "Invalid projectId");

      const deviceStorePath = `${config.stateDir}/mobile-devices.json`;
      const deviceStoreRaw = yield* Effect.promise(() => readFile(deviceStorePath, "utf8"));
      const deviceStore = JSON.parse(deviceStoreRaw) as {
        version: number;
        devices: unknown[];
      };
      assert.equal(deviceStore.version, 1);
      assert.lengthOf(deviceStore.devices, 8);
      if (process.platform !== "win32") {
        const deviceStoreStat = yield* Effect.promise(() => stat(deviceStorePath));
        assert.equal(deviceStoreStat.mode & 0o777, 0o600);
      }
      const stateEntries = yield* Effect.promise(() => readdir(config.stateDir));
      assert.deepEqual(
        stateEntries.filter((entry) => entry.endsWith(".tmp")),
        [],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves attachment files for URL-encoded paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const config = yield* buildAppUnderTest();
      const attachmentPath = resolveAttachmentRelativePath({
        attachmentsDir: config.attachmentsDir,
        relativePath: "thread%20folder/message%20folder/file%20name.png",
      });
      assert.isNotNull(attachmentPath, "Attachment path should be resolvable");

      yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true });
      yield* fileSystem.writeFileString(attachmentPath, "attachment-encoded-ok");

      const response = yield* HttpClient.get(
        "/attachments/thread%20folder/message%20folder/file%20name.png",
      );
      assert.equal(response.status, 200);
      assert.equal(yield* response.text, "attachment-encoded-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns 404 for missing attachment id lookups", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.get(
        "/attachments/missing-11111111-1111-4111-8111-111111111111",
      );
      assert.equal(response.status, 404);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc server.upsertKeybinding", () =>
    Effect.gen(function* () {
      const rule: KeybindingRule = {
        command: "terminal.toggle",
        key: "ctrl+k",
      };
      const resolved: ResolvedKeybindingRule = {
        command: "terminal.toggle",
        shortcut: {
          key: "k",
          metaKey: false,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      };

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            upsertKeybindingRule: () => Effect.succeed([resolved]),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverUpsertKeybinding](rule)),
      );

      assert.deepEqual(response.issues, []);
      assert.deepEqual(response.keybindings, [resolved]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects websocket rpc handshake when auth token is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-auth-required-" });
      yield* fs.writeFileString(
        path.join(workspaceDir, "needle-file.ts"),
        "export const needle = 1;",
      );

      yield* buildAppUnderTest({
        config: {
          authToken: "secret-token",
          requireAuth: true,
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "needle",
            limit: 10,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertInclude(String(result.failure), "SocketOpenError");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("accepts websocket rpc handshake when auth token is provided", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-auth-ok-" });
      yield* fs.writeFileString(
        path.join(workspaceDir, "needle-file.ts"),
        "export const needle = 1;",
      );

      yield* buildAppUnderTest({
        config: {
          authToken: "secret-token",
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws?token=secret-token");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "needle",
            limit: 10,
          }),
        ),
      );

      assert.isAtLeast(response.entries.length, 1);
      assert.equal(response.truncated, false);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc subscribeServerConfig streams snapshot then update", () =>
    Effect.gen(function* () {
      const providers = [] as const;
      const changeEvent = {
        keybindings: [],
        issues: [],
      } as const;

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.succeed(changeEvent),
          },
          providerRegistry: {
            getProviders: Effect.succeed(providers),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(events);
      assert.equal(first?.type, "snapshot");
      if (first?.type === "snapshot") {
        assert.equal(first.version, 1);
        assert.deepEqual(first.config.keybindings, []);
        assert.deepEqual(first.config.issues, []);
        assert.deepEqual(first.config.providers, providers);
        assert.deepEqual(first.config.settings, DEFAULT_SERVER_SETTINGS);
      }
      assert.deepEqual(second, {
        version: 1,
        type: "keybindingsUpdated",
        payload: { issues: [] },
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc subscribeServerConfig emits provider status updates", () =>
    Effect.gen(function* () {
      const providers = [] as const;

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.empty,
          },
          providerRegistry: {
            getProviders: Effect.succeed([]),
            streamChanges: Stream.succeed(providers),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(events);
      assert.equal(first?.type, "snapshot");
      assert.deepEqual(second, {
        version: 1,
        type: "providerStatuses",
        payload: { providers },
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "routes websocket rpc subscribeServerLifecycle replays snapshot and streams updates",
    () =>
      Effect.gen(function* () {
        const lifecycleEvents = [
          {
            version: 1 as const,
            sequence: 1,
            type: "welcome" as const,
            payload: {
              cwd: "/tmp/project",
              projectName: "project",
            },
          },
        ] as const;
        const liveEvents = Stream.make({
          version: 1 as const,
          sequence: 2,
          type: "ready" as const,
          payload: { at: new Date().toISOString() },
        });

        yield* buildAppUnderTest({
          layers: {
            serverLifecycleEvents: {
              snapshot: Effect.succeed({
                sequence: 1,
                events: lifecycleEvents,
              }),
              stream: liveEvents,
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeServerLifecycle]({}).pipe(Stream.take(2), Stream.runCollect),
          ),
        );

        const [first, second] = Array.from(events);
        assert.equal(first?.type, "welcome");
        assert.equal(first?.sequence, 1);
        assert.equal(second?.type, "ready");
        assert.equal(second?.sequence, 2);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.searchEntries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-search-" });
      yield* fs.writeFileString(
        path.join(workspaceDir, "needle-file.ts"),
        "export const needle = 1;",
      );

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "needle",
            limit: 10,
          }),
        ),
      );

      assert.isAtLeast(response.entries.length, 1);
      assert.isTrue(response.entries.some((entry) => entry.path === "needle-file.ts"));
      assert.equal(response.truncated, false);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.searchEntries errors", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: "/definitely/not/a/real/workspace/path",
            query: "needle",
            limit: 10,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "ProjectSearchEntriesError");
      assertInclude(
        result.failure.message,
        "Workspace root does not exist: /definitely/not/a/real/workspace/path",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.writeFile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-write-" });

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            cwd: workspaceDir,
            relativePath: "nested/created.txt",
            contents: "written-by-rpc",
          }),
        ),
      );

      assert.equal(response.relativePath, "nested/created.txt");
      const persisted = yield* fs.readFileString(path.join(workspaceDir, "nested", "created.txt"));
      assert.equal(persisted, "written-by-rpc");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.writeFile errors", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-write-" });

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            cwd: workspaceDir,
            relativePath: "../escape.txt",
            contents: "nope",
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "ProjectWriteFileError");
      assert.equal(
        result.failure.message,
        "Workspace file path must stay within the project root.",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc shell.openInEditor", () =>
    Effect.gen(function* () {
      let openedInput: { cwd: string; editor: EditorId } | null = null;
      yield* buildAppUnderTest({
        layers: {
          open: {
            openInEditor: (input) =>
              Effect.sync(() => {
                openedInput = input;
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.shellOpenInEditor]({
            cwd: "/tmp/project",
            editor: "cursor",
          }),
        ),
      );

      assert.deepEqual(openedInput, { cwd: "/tmp/project", editor: "cursor" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc shell.openInEditor errors", () =>
    Effect.gen(function* () {
      const openError = new OpenError({ message: "Editor command not found: cursor" });
      yield* buildAppUnderTest({
        layers: {
          open: {
            openInEditor: () => Effect.fail(openError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.shellOpenInEditor]({
            cwd: "/tmp/project",
            editor: "cursor",
          }),
        ).pipe(Effect.result),
      );

      assertFailure(result, openError);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc git methods", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          gitManager: {
            status: () =>
              Effect.succeed({
                isRepo: true,
                hasOriginRemote: true,
                isDefaultBranch: true,
                branch: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                pr: null,
              }),
            resolvePullRequest: () =>
              Effect.succeed({
                pullRequest: {
                  number: 1,
                  title: "Demo PR",
                  url: "https://example.com/pr/1",
                  baseBranch: "main",
                  headBranch: "feature/demo",
                  state: "open",
                },
              }),
            preparePullRequestThread: () =>
              Effect.succeed({
                pullRequest: {
                  number: 1,
                  title: "Demo PR",
                  url: "https://example.com/pr/1",
                  baseBranch: "main",
                  headBranch: "feature/demo",
                  state: "open",
                },
                branch: "feature/demo",
                worktreePath: null,
              }),
          },
          gitCore: {
            listBranches: () =>
              Effect.succeed({
                branches: [
                  {
                    name: "main",
                    current: true,
                    isDefault: true,
                    worktreePath: null,
                  },
                ],
                isRepo: true,
                hasOriginRemote: true,
                nextCursor: null,
                totalCount: 1,
              }),
            createWorktree: () =>
              Effect.succeed({
                worktree: { path: "/tmp/wt", branch: "feature/demo" },
              }),
            removeWorktree: () => Effect.void,
            createBranch: () => Effect.void,
            checkoutBranch: () => Effect.void,
            initRepo: () => Effect.void,
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const status = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.gitStatus]({ cwd: "/tmp/repo" })),
      );
      assert.equal(status.branch, "main");

      const resolvedPr = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitResolvePullRequest]({
            cwd: "/tmp/repo",
            reference: "1",
          }),
        ),
      );
      assert.equal(resolvedPr.pullRequest.number, 1);

      const prepared = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitPreparePullRequestThread]({
            cwd: "/tmp/repo",
            reference: "1",
            mode: "local",
          }),
        ),
      );
      assert.equal(prepared.branch, "feature/demo");

      const branches = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitListBranches]({ cwd: "/tmp/repo" }),
        ),
      );
      assert.equal(branches.branches[0]?.name, "main");

      const worktree = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCreateWorktree]({
            cwd: "/tmp/repo",
            branch: "main",
            path: null,
          }),
        ),
      );
      assert.equal(worktree.worktree.branch, "feature/demo");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitRemoveWorktree]({
            cwd: "/tmp/repo",
            path: "/tmp/wt",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCreateBranch]({
            cwd: "/tmp/repo",
            branch: "feature/new",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCheckout]({
            cwd: "/tmp/repo",
            branch: "main",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitInit]({
            cwd: "/tmp/repo",
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc orchestration methods", () =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const snapshot = {
        snapshotSequence: 1,
        updatedAt: now,
        projects: [
          {
            id: ProjectId.makeUnsafe("project-a"),
            title: "Project A",
            workspaceRoot: "/tmp/project-a",
            defaultModelSelection,
            scripts: [],
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
        ],
        threads: [
          {
            id: ThreadId.makeUnsafe("thread-1"),
            projectId: ProjectId.makeUnsafe("project-a"),
            title: "Thread A",
            modelSelection: defaultModelSelection,
            interactionMode: "default" as const,
            runtimeMode: "full-access" as const,
            parentThreadId: null,
            branchSourceTurnId: null,
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            latestTurn: null,
            messages: [],
            session: null,
            activities: [],
            proposedPlans: [],
            checkpoints: [],
            deletedAt: null,
          },
        ],
      };

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            getReadModel: () => Effect.succeed(snapshot),
            dispatch: () => Effect.succeed({ sequence: 7 }),
            readEvents: () => Stream.empty,
          },
          checkpointDiffQuery: {
            getTurnDiff: () =>
              Effect.succeed({
                threadId: ThreadId.makeUnsafe("thread-1"),
                fromTurnCount: 0,
                toTurnCount: 1,
                diff: "turn-diff",
              }),
            getFullThreadDiff: () =>
              Effect.succeed({
                threadId: ThreadId.makeUnsafe("thread-1"),
                fromTurnCount: 0,
                toTurnCount: 1,
                diff: "full-diff",
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const snapshotResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[ORCHESTRATION_WS_METHODS.getSnapshot]({})),
      );
      assert.equal(snapshotResult.snapshotSequence, 1);

      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.session.stop",
            commandId: CommandId.makeUnsafe("cmd-1"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            createdAt: now,
          }),
        ),
      );
      assert.equal(dispatchResult.sequence, 7);

      const turnDiffResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getTurnDiff]({
            threadId: ThreadId.makeUnsafe("thread-1"),
            fromTurnCount: 0,
            toTurnCount: 1,
          }),
        ),
      );
      assert.equal(turnDiffResult.diff, "turn-diff");

      const fullDiffResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getFullThreadDiff]({
            threadId: ThreadId.makeUnsafe("thread-1"),
            toTurnCount: 1,
          }),
        ),
      );
      assert.equal(fullDiffResult.diff, "full-diff");

      const replayResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.replayEvents]({
            fromSequenceExclusive: 0,
          }),
        ),
      );
      assert.deepEqual(replayResult, []);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("closes thread terminals after a successful archive command", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.makeUnsafe("thread-archive");
      const closeInputs: Array<Parameters<TerminalManagerShape["close"]>[0]> = [];

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                closeInputs.push(input);
              }),
          },
          orchestrationEngine: {
            dispatch: () => Effect.succeed({ sequence: 8 }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.makeUnsafe("cmd-thread-archive"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 8);
      assert.deepEqual(closeInputs, [{ threadId }]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects harness-only goal commands at the websocket boundary", () =>
    Effect.gen(function* () {
      let dispatchCalls = 0;
      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            dispatch: () =>
              Effect.sync(() => {
                dispatchCalls += 1;
                return { sequence: 9 };
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.exit(
        Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.goal.status.report",
              commandId: CommandId.makeUnsafe("server:forged-goal-status"),
              threadId: ThreadId.makeUnsafe("thread-1"),
              expectedGoalLifecycleKey: "goal:lifecycle-1",
              status: "complete",
              createdAt: "2026-07-16T10:00:00.000Z",
            } as never),
          ),
        ),
      );

      assertTrue(result._tag === "Failure");
      assert.equal(dispatchCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc subscribeOrchestrationDomainEvents as a live-only stream", () =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const threadId = ThreadId.makeUnsafe("thread-1");
      const makeEvent = (sequence: number): OrchestrationEvent =>
        ({
          sequence,
          eventId: `event-${sequence}`,
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.reverted",
          payload: {
            threadId,
            turnCount: sequence,
          },
        }) as OrchestrationEvent;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            getReadModel: () =>
              Effect.succeed({
                ...makeDefaultOrchestrationReadModel(),
                snapshotSequence: 3,
              }),
            streamDomainEvents: Stream.make(makeEvent(4), makeEvent(5)),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeOrchestrationDomainEvents]({}).pipe(
            Stream.take(2),
            Stream.runCollect,
          ),
        ),
      );

      assert.deepEqual(
        Array.from(events).map((event) => event.sequence),
        [4, 5],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc orchestration.getSnapshot from the live read model", () =>
    Effect.gen(function* () {
      const snapshot = {
        ...makeDefaultOrchestrationReadModel(),
        snapshotSequence: 42,
      };

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            getReadModel: () => Effect.succeed(snapshot),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[ORCHESTRATION_WS_METHODS.getSnapshot]({})),
      );

      assert.equal(result.snapshotSequence, 42);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc terminal methods", () =>
    Effect.gen(function* () {
      const snapshot = {
        threadId: "thread-1",
        terminalId: "default",
        cwd: "/tmp/project",
        status: "running" as const,
        pid: 1234,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: new Date().toISOString(),
      };

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            open: () => Effect.succeed(snapshot),
            write: () => Effect.void,
            resize: () => Effect.void,
            clear: () => Effect.void,
            restart: () => Effect.succeed(snapshot),
            close: () => Effect.void,
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const opened = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalOpen]({
            threadId: "thread-1",
            terminalId: "default",
            cwd: "/tmp/project",
          }),
        ),
      );
      assert.equal(opened.terminalId, "default");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalWrite]({
            threadId: "thread-1",
            terminalId: "default",
            data: "echo hi\n",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalResize]({
            threadId: "thread-1",
            terminalId: "default",
            cols: 120,
            rows: 40,
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalClear]({
            threadId: "thread-1",
            terminalId: "default",
          }),
        ),
      );

      const restarted = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalRestart]({
            threadId: "thread-1",
            terminalId: "default",
            cwd: "/tmp/project",
            cols: 120,
            rows: 40,
          }),
        ),
      );
      assert.equal(restarted.terminalId, "default");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalClose]({
            threadId: "thread-1",
            terminalId: "default",
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc terminal.write errors", () =>
    Effect.gen(function* () {
      const terminalError = new TerminalNotRunningError({
        threadId: "thread-1",
        terminalId: "default",
      });
      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            write: () => Effect.fail(terminalError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalWrite]({
            threadId: "thread-1",
            terminalId: "default",
            data: "echo fail\n",
          }),
        ).pipe(Effect.result),
      );

      assertFailure(result, terminalError);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
