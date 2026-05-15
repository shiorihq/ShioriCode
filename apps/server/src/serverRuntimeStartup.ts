import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  ProjectId,
  ThreadId,
} from "contracts";
import {
  Data,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Path,
  Queue,
  Ref,
  Scope,
  ServiceMap,
} from "effect";
import { normalizeProjectTitle } from "shared/String";

import { ServerConfig } from "./config";
import { Keybindings } from "./keybindings";
import { Open } from "./open";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { OrchestrationReactor } from "./orchestration/Services/OrchestrationReactor";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerSettingsService } from "./serverSettings";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService";
import { ProviderSessionReaper } from "./provider/Services/ProviderSessionReaper";

function resolveProjectTitle(cwd: string, pathService: Pick<Path.Path, "basename">): string {
  return normalizeProjectTitle(pathService.basename(cwd));
}

const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

export class ServerRuntimeStartupError extends Data.TaggedError("ServerRuntimeStartupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ServerRuntimeStartupShape {
  readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
  readonly markHttpListening: Effect.Effect<void>;
  readonly enqueueCommand: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
}

export class ServerRuntimeStartup extends ServiceMap.Service<
  ServerRuntimeStartup,
  ServerRuntimeStartupShape
>()("t3/serverRuntimeStartup") {}

interface QueuedCommand {
  readonly run: Effect.Effect<void, never>;
}

type CommandReadinessState = "pending" | "ready" | ServerRuntimeStartupError;

interface CommandGate {
  readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
  readonly signalCommandReady: Effect.Effect<void>;
  readonly failCommandReady: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
  readonly enqueueCommand: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
}

const STARTUP_COMMAND_QUEUE_CAPACITY = 1_000;

const settleQueuedCommand = <A, E>(deferred: Deferred.Deferred<A, E>, exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit)
    ? Deferred.succeed(deferred, exit.value)
    : Deferred.failCause(deferred, exit.cause);

export const makeCommandGate = Effect.gen(function* () {
  const commandReady = yield* Deferred.make<void, ServerRuntimeStartupError>();
  const commandQueue = yield* Queue.bounded<QueuedCommand>(STARTUP_COMMAND_QUEUE_CAPACITY);
  const commandReadinessState = yield* Ref.make<CommandReadinessState>("pending");

  const commandWorker = Effect.forever(
    Queue.take(commandQueue).pipe(Effect.flatMap((command) => command.run)),
  );
  yield* Effect.forkScoped(commandWorker);

  return {
    awaitCommandReady: Deferred.await(commandReady),
    signalCommandReady: Effect.gen(function* () {
      yield* Ref.set(commandReadinessState, "ready");
      yield* Deferred.succeed(commandReady, undefined).pipe(Effect.orDie);
    }),
    failCommandReady: (error) =>
      Effect.gen(function* () {
        yield* Ref.set(commandReadinessState, error);
        yield* Deferred.fail(commandReady, error).pipe(Effect.orDie);
      }),
    enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const readinessState = yield* Ref.get(commandReadinessState);
        if (readinessState === "ready") {
          return yield* effect;
        }
        if (readinessState !== "pending") {
          return yield* readinessState;
        }

        const result = yield* Deferred.make<A, E | ServerRuntimeStartupError>();
        yield* Queue.offer(commandQueue, {
          run: Deferred.await(commandReady).pipe(
            Effect.flatMap(() => effect),
            Effect.exit,
            Effect.flatMap((exit) => settleQueuedCommand(result, exit)),
          ),
        });
        return yield* Deferred.await(result);
      }),
  } satisfies CommandGate;
});

export const recordStartupHeartbeat = Effect.gen(function* () {
  const analytics = yield* AnalyticsService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const { threadCount, projectCount } = yield* projectionSnapshotQuery.getCounts().pipe(
    Effect.catch((cause) =>
      Effect.logWarning("failed to gather startup projection counts for telemetry", {
        cause,
      }).pipe(
        Effect.as({
          threadCount: 0,
          projectCount: 0,
        }),
      ),
    ),
  );

  yield* analytics.record("server.boot.heartbeat", {
    threadCount,
    projectCount,
  });
});

export const launchStartupHeartbeat = recordStartupHeartbeat.pipe(
  Effect.ignoreCause({ log: true }),
  Effect.forkScoped,
  Effect.asVoid,
);

export const autoBootstrapWelcome = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const serverSettings = yield* ServerSettingsService;
  const path = yield* Path.Path;
  const bootstrapProjectTitle = resolveProjectTitle(serverConfig.cwd, path);

  let bootstrapProjectId: ProjectId | undefined;
  let bootstrapThreadId: ThreadId | undefined;

  if (serverConfig.autoBootstrapProjectFromCwd) {
    yield* Effect.gen(function* () {
      const existingProject = yield* projectionReadModelQuery.getActiveProjectByWorkspaceRoot(
        serverConfig.cwd,
      );
      let nextProjectId: ProjectId;
      let nextProjectDefaultModelSelection: ModelSelection;

      if (Option.isNone(existingProject)) {
        const createdAt = new Date().toISOString();
        nextProjectId = ProjectId.makeUnsafe(crypto.randomUUID());
        const settings = yield* serverSettings.getSettings;
        nextProjectDefaultModelSelection =
          settings.defaultModelSelection ?? DEFAULT_SERVER_SETTINGS.defaultModelSelection;
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          projectId: nextProjectId,
          title: bootstrapProjectTitle,
          workspaceRoot: serverConfig.cwd,
          defaultModelSelection: nextProjectDefaultModelSelection,
          createdAt,
        });
      } else {
        nextProjectId = existingProject.value.id;
        nextProjectDefaultModelSelection =
          existingProject.value.defaultModelSelection ??
          (yield* serverSettings.getSettings).defaultModelSelection ??
          DEFAULT_SERVER_SETTINGS.defaultModelSelection;
        if (normalizeProjectTitle(existingProject.value.title) !== bootstrapProjectTitle) {
          yield* orchestrationEngine.dispatch({
            type: "project.meta.update",
            commandId: CommandId.makeUnsafe(crypto.randomUUID()),
            projectId: nextProjectId,
            title: bootstrapProjectTitle,
          });
        }
      }

      const existingThreadId =
        yield* projectionReadModelQuery.getFirstActiveThreadIdByProjectId(nextProjectId);
      if (Option.isNone(existingThreadId)) {
        const createdAt = new Date().toISOString();
        const createdThreadId = ThreadId.makeUnsafe(crypto.randomUUID());
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId: createdThreadId,
          projectId: nextProjectId,
          title: "New Thread",
          modelSelection: nextProjectDefaultModelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          parentThreadId: null,
          branchSourceTurnId: null,
          branch: null,
          worktreePath: null,
          createdAt,
        });
        bootstrapProjectId = nextProjectId;
        bootstrapThreadId = createdThreadId;
      } else {
        bootstrapProjectId = nextProjectId;
        bootstrapThreadId = existingThreadId.value;
      }
    });
  }

  return {
    cwd: serverConfig.cwd,
    projectName: bootstrapProjectTitle,
    ...(bootstrapProjectId ? { bootstrapProjectId } : {}),
    ...(bootstrapThreadId ? { bootstrapThreadId } : {}),
  } as const;
});

const maybeOpenBrowser = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  if (serverConfig.noBrowser) {
    return;
  }
  const { openBrowser } = yield* Open;
  const localUrl = `http://localhost:${serverConfig.port}`;
  const bindUrl =
    serverConfig.host && !isWildcardHost(serverConfig.host)
      ? `http://${formatHostForUrl(serverConfig.host)}:${serverConfig.port}`
      : localUrl;
  const target = serverConfig.devUrl?.toString() ?? bindUrl;

  yield* openBrowser(target).pipe(
    Effect.catch(() =>
      Effect.logInfo("browser auto-open unavailable", {
        hint: `Open ${target} in your browser.`,
      }),
    ),
  );
});

const makeServerRuntimeStartup = Effect.gen(function* () {
  const keybindings = yield* Keybindings;
  const orchestrationReactor = yield* OrchestrationReactor;
  const providerSessionReaper = yield* ProviderSessionReaper;
  const lifecycleEvents = yield* ServerLifecycleEvents;
  const serverSettings = yield* ServerSettingsService;

  const commandGate = yield* makeCommandGate;
  const httpListening = yield* Deferred.make<void>();
  const reactorScope = yield* Scope.make("sequential");

  yield* Effect.addFinalizer(() => Scope.close(reactorScope, Exit.void));

  const startup = Effect.gen(function* () {
    yield* Effect.logDebug("startup phase: starting keybindings runtime");
    yield* keybindings.start.pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to start keybindings runtime", {
          path: error.configPath,
          detail: error.detail,
          cause: error.cause,
        }),
      ),
      Effect.forkScoped,
    );

    yield* Effect.logDebug("startup phase: starting server settings runtime");
    yield* serverSettings.start.pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to start server settings runtime", {
          path: error.settingsPath,
          detail: error.detail,
          cause: error.cause,
        }),
      ),
      Effect.forkScoped,
    );

    yield* Effect.logDebug("startup phase: starting orchestration reactors");
    yield* orchestrationReactor.start().pipe(Scope.provide(reactorScope));

    yield* Effect.logDebug("startup phase: starting provider session reaper");
    yield* providerSessionReaper.start().pipe(Scope.provide(reactorScope));

    yield* Effect.logDebug("startup phase: preparing welcome payload");
    const welcome = yield* autoBootstrapWelcome;
    yield* Effect.logDebug("startup phase: publishing welcome event", {
      cwd: welcome.cwd,
      projectName: welcome.projectName,
      bootstrapProjectId: welcome.bootstrapProjectId,
      bootstrapThreadId: welcome.bootstrapThreadId,
    });
    yield* lifecycleEvents.publish({
      version: 1,
      type: "welcome",
      payload: welcome,
    });
  });

  yield* Effect.forkScoped(
    Effect.gen(function* () {
      const startupExit = yield* Effect.exit(startup);
      if (Exit.isFailure(startupExit)) {
        const error = new ServerRuntimeStartupError({
          message: "Server runtime startup failed before command readiness.",
          cause: startupExit.cause,
        });
        yield* Effect.logError("server runtime startup failed", { cause: startupExit.cause });
        yield* commandGate.failCommandReady(error);
        return;
      }

      yield* Effect.logDebug("Accepting commands");
      yield* commandGate.signalCommandReady;
      yield* Effect.logDebug("startup phase: waiting for http listener");
      yield* Deferred.await(httpListening);
      yield* Effect.logDebug("startup phase: publishing ready event");
      yield* lifecycleEvents.publish({
        version: 1,
        type: "ready",
        payload: { at: new Date().toISOString() },
      });

      yield* Effect.logDebug("startup phase: recording startup heartbeat");
      yield* launchStartupHeartbeat;
      yield* Effect.logDebug("startup phase: browser open check");
      yield* maybeOpenBrowser;
      yield* Effect.logDebug("startup phase: complete");
    }),
  );

  return {
    awaitCommandReady: commandGate.awaitCommandReady,
    markHttpListening: Deferred.succeed(httpListening, undefined),
    enqueueCommand: commandGate.enqueueCommand,
  } satisfies ServerRuntimeStartupShape;
});

export const ServerRuntimeStartupLive = Layer.effect(
  ServerRuntimeStartup,
  makeServerRuntimeStartup,
);
