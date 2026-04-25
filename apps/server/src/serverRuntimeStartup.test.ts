import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationCommand,
  type OrchestrationProject,
  ProjectId,
  ThreadId,
} from "contracts";
import { Deferred, Effect, Fiber, Layer, Option, Ref, Stream } from "effect";

import { ServerConfig, type ServerConfigShape } from "./config.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine.ts";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import {
  autoBootstrapWelcome,
  launchStartupHeartbeat,
  makeCommandGate,
  ServerRuntimeStartupError,
} from "./serverRuntimeStartup.ts";

function makeServerConfig(cwd: string): ServerConfigShape {
  return {
    logLevel: "Error",
    mode: "web",
    port: 0,
    host: undefined,
    cwd,
    baseDir: "/tmp/shioricode-test",
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: true,
    logWebSocketEvents: false,
    serverInstancePath: "/tmp/shioricode-test/server-instance.json",
    stateDir: "/tmp/shioricode-test/state",
    dbPath: "/tmp/shioricode-test/state/state.sqlite",
    keybindingsConfigPath: "/tmp/shioricode-test/state/keybindings.json",
    settingsPath: "/tmp/shioricode-test/state/settings.json",
    worktreesDir: "/tmp/shioricode-test/worktrees",
    attachmentsDir: "/tmp/shioricode-test/state/attachments",
    logsDir: "/tmp/shioricode-test/state/logs",
    serverLogPath: "/tmp/shioricode-test/state/logs/server.log",
    providerLogsDir: "/tmp/shioricode-test/state/logs/provider",
    providerEventLogPath: "/tmp/shioricode-test/state/logs/provider/events.log",
    terminalLogsDir: "/tmp/shioricode-test/state/logs/terminals",
    anonymousIdPath: "/tmp/shioricode-test/state/anonymous-id",
  } satisfies ServerConfigShape;
}

function makeOrchestrationEngine(commands: OrchestrationCommand[]): OrchestrationEngineShape {
  return {
    getReadModel: () => Effect.die("unused"),
    readEvents: () => Stream.empty,
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length };
      }),
    streamDomainEvents: Stream.empty,
  } satisfies OrchestrationEngineShape;
}

function makeProjectionSnapshotQuery(input: {
  existingProject: Option.Option<OrchestrationProject>;
  existingThreadId: Option.Option<ThreadId>;
}): ProjectionSnapshotQueryShape {
  return {
    getSnapshot: () => Effect.die("unused"),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.succeed(input.existingProject),
    getFirstActiveThreadIdByProjectId: () => Effect.succeed(input.existingThreadId),
    getThreadCheckpointContext: () => Effect.succeed(Option.none()),
  } satisfies ProjectionSnapshotQueryShape;
}

it.effect("enqueueCommand waits for readiness and then drains queued work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const executionCount = yield* Ref.make(0);
      const commandGate = yield* makeCommandGate;

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Ref.updateAndGet(executionCount, (count) => count + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(executionCount), 0);

      yield* commandGate.signalCommandReady;

      const result = yield* Fiber.join(queuedCommandFiber);
      assert.equal(result, 1);
      assert.equal(yield* Ref.get(executionCount), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartupError({
          message: "startup failed",
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "startup failed");
    }),
  ),
);

it.effect("launchStartupHeartbeat does not block the caller while counts are loading", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const releaseCounts = yield* Deferred.make<void, never>();

      yield* launchStartupHeartbeat.pipe(
        Effect.provideService(ProjectionSnapshotQuery, {
          getSnapshot: () => Effect.die("unused"),
          getCounts: () =>
            Deferred.await(releaseCounts).pipe(
              Effect.as({
                projectCount: 2,
                threadCount: 3,
              }),
            ),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        }),
        Effect.provideService(AnalyticsService, {
          record: () => Effect.void,
          flush: Effect.void,
        }),
      );
    }),
  ),
);

it.effect("autoBootstrapWelcome names new projects from the workspace folder", () =>
  Effect.gen(function* () {
    const commands: OrchestrationCommand[] = [];
    const cwd = "/tmp/github.com/pingdotgg/shiori-code";
    const testLayer = Layer.mergeAll(
      NodeServices.layer,
      ServerSettingsService.layerTest(),
      Layer.succeed(ServerConfig, makeServerConfig(cwd)),
      Layer.succeed(
        ProjectionSnapshotQuery,
        makeProjectionSnapshotQuery({
          existingProject: Option.none(),
          existingThreadId: Option.none(),
        }),
      ),
      Layer.succeed(OrchestrationEngineService, makeOrchestrationEngine(commands)),
    );

    const welcome = yield* autoBootstrapWelcome.pipe(Effect.provide(testLayer));

    assert.equal(welcome.projectName, "shiori-code");

    const projectCreate = commands.find((command) => command.type === "project.create");
    if (projectCreate?.type !== "project.create") {
      throw new Error("Expected a bootstrap project.create command.");
    }

    const threadCreate = commands.find((command) => command.type === "thread.create");
    if (threadCreate?.type !== "thread.create") {
      throw new Error("Expected a bootstrap thread.create command.");
    }

    assert.equal(projectCreate.title, "shiori-code");
    assert.equal(
      projectCreate.defaultModelSelection,
      DEFAULT_SERVER_SETTINGS.defaultModelSelection,
    );
    assert.equal(welcome.bootstrapProjectId, projectCreate.projectId);
    assert.equal(welcome.bootstrapThreadId, threadCreate.threadId);
  }),
);

it.effect("autoBootstrapWelcome renames existing projects to the workspace folder name", () =>
  Effect.gen(function* () {
    const commands: OrchestrationCommand[] = [];
    const cwd = "/tmp/github.com/pingdotgg/shiori-code";
    const projectId = ProjectId.makeUnsafe("project-1");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const existingProject: OrchestrationProject = {
      id: projectId,
      title: "FujiwaraChoki/shioricode",
      workspaceRoot: cwd,
      defaultModelSelection: DEFAULT_SERVER_SETTINGS.defaultModelSelection,
      scripts: [],
      createdAt: "2026-04-17T00:00:00.000Z",
      updatedAt: "2026-04-17T00:00:00.000Z",
      deletedAt: null,
    };
    const testLayer = Layer.mergeAll(
      NodeServices.layer,
      ServerSettingsService.layerTest(),
      Layer.succeed(ServerConfig, makeServerConfig(cwd)),
      Layer.succeed(
        ProjectionSnapshotQuery,
        makeProjectionSnapshotQuery({
          existingProject: Option.some(existingProject),
          existingThreadId: Option.some(threadId),
        }),
      ),
      Layer.succeed(OrchestrationEngineService, makeOrchestrationEngine(commands)),
    );

    const welcome = yield* autoBootstrapWelcome.pipe(Effect.provide(testLayer));

    assert.equal(welcome.projectName, "shiori-code");
    assert.equal(welcome.bootstrapProjectId, projectId);
    assert.equal(welcome.bootstrapThreadId, threadId);
    assert.equal(
      commands.some((command) => command.type === "project.create"),
      false,
    );
    assert.equal(
      commands.some((command) => command.type === "thread.create"),
      false,
    );

    const projectMetaUpdate = commands.find((command) => command.type === "project.meta.update");
    if (projectMetaUpdate?.type !== "project.meta.update") {
      throw new Error("Expected a bootstrap project.meta.update command.");
    }

    assert.equal(projectMetaUpdate.projectId, projectId);
    assert.equal(projectMetaUpdate.title, "shiori-code");
  }),
);
