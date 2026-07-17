import { NetService } from "shared/Net";
import { Config, Effect, LogLevel, Option, Schema } from "effect";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";

import {
  DEFAULT_PORT,
  deriveServerPaths,
  ensureServerDirectories,
  resolveStaticDir,
  ServerConfig,
  RuntimeMode,
  type ServerConfigShape,
} from "./config";
import { readBootstrapEnvelope } from "./bootstrap";
import { runBrowserPanelMcpServer } from "./browserPanelMcpServer";
import { runComputerUseMcpServer } from "./computer/mcpServer";
import { runThreadGoalMcpServer } from "./threadGoalMcpServer";
import {
  connectLinkEnvironment,
  disconnectLinkEnvironment,
  listLinkEnvironments,
  linkStatus,
} from "./linkCli";
import { resolveBaseDir } from "./os-jank";
import { providerDoctor } from "./providerDoctor";
import { openShioriCodeDirectory } from "./openCli";
import { remoteStatus, setRemoteExposure } from "./remoteCli";
import { runServer } from "./server";
import {
  controlService,
  installService,
  serviceSummary,
  type ServiceAction,
} from "./serviceManager";

const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

const BootstrapEnvelopeSchema = Schema.Struct({
  mode: Schema.optional(RuntimeMode),
  port: Schema.optional(PortSchema),
  host: Schema.optional(Schema.String),
  shioriCodeHome: Schema.optional(Schema.String),
  devUrl: Schema.optional(Schema.URLFromString),
  noBrowser: Schema.optional(Schema.Boolean),
  authToken: Schema.optional(Schema.String),
  autoBootstrapProjectFromCwd: Schema.optional(Schema.Boolean),
  logWebSocketEvents: Schema.optional(Schema.Boolean),
});

const modeFlag = Flag.choice("mode", RuntimeMode.literals).pipe(
  Flag.withDescription("Runtime mode. `desktop` keeps loopback defaults unless overridden."),
  Flag.optional,
);
const portFlag = Flag.integer("port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("Port for the HTTP/WebSocket server."),
  Flag.optional,
);
const hostFlag = Flag.string("host").pipe(
  Flag.withDescription("Host/interface to bind (for example 127.0.0.1, 0.0.0.0, or a Tailnet IP)."),
  Flag.optional,
);
const baseDirFlag = Flag.string("base-dir").pipe(
  Flag.withDescription("Base directory path (equivalent to SHIORICODE_HOME)."),
  Flag.optional,
);
const devUrlFlag = Flag.string("dev-url").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Dev web URL to proxy/redirect to (equivalent to VITE_DEV_SERVER_URL)."),
  Flag.optional,
);
const noBrowserFlag = Flag.boolean("no-browser").pipe(
  Flag.withDescription("Disable automatic browser opening."),
  Flag.optional,
);
const authTokenFlag = Flag.string("auth-token").pipe(
  Flag.withDescription("Auth token required for WebSocket connections."),
  Flag.withAlias("token"),
  Flag.optional,
);
const bootstrapFdFlag = Flag.integer("bootstrap-fd").pipe(
  Flag.withSchema(Schema.Int),
  Flag.withDescription("Read one-time bootstrap secrets from the given file descriptor."),
  Flag.optional,
);
const remoteFlag = Flag.boolean("remote").pipe(
  Flag.withDescription(
    "Mark this server as remotely reachable (behind a tunnel/reverse proxy). Requires credentials and enables session auth even though the bind stays on loopback.",
  ),
  Flag.withAlias("expose"),
  Flag.optional,
);
const requireAuthFlag = Flag.boolean("require-auth").pipe(
  Flag.withDescription("Require credential login even on a loopback bind."),
  Flag.optional,
);
const unsafeNoAuthFlag = Flag.boolean("unsafe-no-auth").pipe(
  Flag.withDescription(
    "Disable authentication even when remotely reachable. Dangerous: anyone who can reach the server gets full shell access.",
  ),
  Flag.optional,
);
const autoBootstrapProjectFromCwdFlag = Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
  Flag.withDescription(
    "Create a project for the current working directory on startup when missing.",
  ),
  Flag.optional,
);
const logWebSocketEventsFlag = Flag.boolean("log-websocket-events").pipe(
  Flag.withDescription(
    "Emit server-side logs for outbound WebSocket push traffic (equivalent to SHIORICODE_LOG_WS_EVENTS).",
  ),
  Flag.withAlias("log-ws-events"),
  Flag.optional,
);

const EnvServerConfig = Config.all({
  logLevel: Config.logLevel("SHIORICODE_LOG_LEVEL").pipe(Config.withDefault("Info")),
  mode: Config.schema(RuntimeMode, "SHIORICODE_MODE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  port: Config.port("SHIORICODE_PORT").pipe(Config.option, Config.map(Option.getOrUndefined)),
  host: Config.string("SHIORICODE_HOST").pipe(Config.option, Config.map(Option.getOrUndefined)),
  shioriCodeHome: Config.string("SHIORICODE_HOME").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  devUrl: Config.url("VITE_DEV_SERVER_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
  noBrowser: Config.boolean("SHIORICODE_NO_BROWSER").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  authToken: Config.string("SHIORICODE_AUTH_TOKEN").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  remote: Config.boolean("SHIORICODE_REMOTE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  requireAuth: Config.boolean("SHIORICODE_REQUIRE_AUTH").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  unsafeNoAuth: Config.boolean("SHIORICODE_UNSAFE_NO_AUTH").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  bootstrapFd: Config.int("SHIORICODE_BOOTSTRAP_FD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  autoBootstrapProjectFromCwd: Config.boolean("SHIORICODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  logWebSocketEvents: Config.boolean("SHIORICODE_LOG_WS_EVENTS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
});

interface CliServerFlags {
  readonly mode: Option.Option<RuntimeMode>;
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly baseDir: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
  readonly noBrowser: Option.Option<boolean>;
  readonly authToken: Option.Option<string>;
  readonly remote: Option.Option<boolean>;
  readonly requireAuth: Option.Option<boolean>;
  readonly unsafeNoAuth: Option.Option<boolean>;
  readonly bootstrapFd: Option.Option<number>;
  readonly autoBootstrapProjectFromCwd: Option.Option<boolean>;
  readonly logWebSocketEvents: Option.Option<boolean>;
}

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(Option.filter(flag, Boolean), () => envValue);

const resolveOptionPrecedence = <Value>(
  ...values: ReadonlyArray<Option.Option<Value>>
): Option.Option<Value> => Option.firstSomeOf(values);

export const resolveServerConfig = (
  flags: CliServerFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
) =>
  Effect.gen(function* () {
    const { findAvailablePort } = yield* NetService;
    const env = yield* EnvServerConfig;
    const bootstrapFd = Option.getOrUndefined(flags.bootstrapFd) ?? env.bootstrapFd;
    const bootstrapEnvelope =
      bootstrapFd !== undefined
        ? yield* readBootstrapEnvelope(BootstrapEnvelopeSchema, bootstrapFd)
        : Option.none();

    const mode: RuntimeMode = Option.getOrElse(
      resolveOptionPrecedence(
        flags.mode,
        Option.fromUndefinedOr(env.mode),
        Option.flatMap(bootstrapEnvelope, (bootstrap) => Option.fromUndefinedOr(bootstrap.mode)),
      ),
      () => "web",
    );

    const port = yield* Option.match(
      resolveOptionPrecedence(
        flags.port,
        Option.fromUndefinedOr(env.port),
        Option.flatMap(bootstrapEnvelope, (bootstrap) => Option.fromUndefinedOr(bootstrap.port)),
      ),
      {
        onSome: (value) => Effect.succeed(value),
        onNone: () => {
          if (mode === "desktop") {
            return Effect.succeed(DEFAULT_PORT);
          }
          return findAvailablePort(DEFAULT_PORT);
        },
      },
    );
    const devUrl = Option.getOrElse(
      resolveOptionPrecedence(
        flags.devUrl,
        Option.fromUndefinedOr(env.devUrl),
        Option.flatMap(bootstrapEnvelope, (bootstrap) => Option.fromUndefinedOr(bootstrap.devUrl)),
      ),
      () => undefined,
    );
    const baseDir = yield* resolveBaseDir(
      Option.getOrUndefined(
        resolveOptionPrecedence(
          flags.baseDir,
          Option.fromUndefinedOr(env.shioriCodeHome),
          Option.flatMap(bootstrapEnvelope, (bootstrap) =>
            Option.fromUndefinedOr(bootstrap.shioriCodeHome),
          ),
        ),
      ),
    );
    const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
    yield* ensureServerDirectories(derivedPaths);
    const noBrowser = resolveBooleanFlag(
      flags.noBrowser,
      Option.getOrElse(
        resolveOptionPrecedence(
          Option.fromUndefinedOr(env.noBrowser),
          Option.flatMap(bootstrapEnvelope, (bootstrap) =>
            Option.fromUndefinedOr(bootstrap.noBrowser),
          ),
        ),
        () => mode === "desktop",
      ),
    );
    const authToken = Option.getOrUndefined(
      resolveOptionPrecedence(
        flags.authToken,
        Option.fromUndefinedOr(env.authToken),
        Option.flatMap(bootstrapEnvelope, (bootstrap) =>
          Option.fromUndefinedOr(bootstrap.authToken),
        ),
      ),
    );
    const autoBootstrapProjectFromCwd = resolveBooleanFlag(
      flags.autoBootstrapProjectFromCwd,
      Option.getOrElse(
        resolveOptionPrecedence(
          Option.fromUndefinedOr(env.autoBootstrapProjectFromCwd),
          Option.flatMap(bootstrapEnvelope, (bootstrap) =>
            Option.fromUndefinedOr(bootstrap.autoBootstrapProjectFromCwd),
          ),
        ),
        () => mode === "web",
      ),
    );
    const logWebSocketEvents = resolveBooleanFlag(
      flags.logWebSocketEvents,
      Option.getOrElse(
        resolveOptionPrecedence(
          Option.fromUndefinedOr(env.logWebSocketEvents),
          Option.flatMap(bootstrapEnvelope, (bootstrap) =>
            Option.fromUndefinedOr(bootstrap.logWebSocketEvents),
          ),
        ),
        () => Boolean(devUrl),
      ),
    );
    const staticDir = devUrl ? undefined : yield* resolveStaticDir();
    const host = Option.getOrElse(
      resolveOptionPrecedence(
        flags.host,
        Option.fromUndefinedOr(env.host),
        Option.flatMap(bootstrapEnvelope, (bootstrap) => Option.fromUndefinedOr(bootstrap.host)),
      ),
      () => "127.0.0.1",
    );
    const logLevel = Option.getOrElse(cliLogLevel, () => env.logLevel);

    const remoteIntent = resolveBooleanFlag(flags.remote, env.remote ?? false);
    const explicitRequireAuth = resolveBooleanFlag(flags.requireAuth, env.requireAuth ?? false);
    const unsafeNoAuth = resolveBooleanFlag(flags.unsafeNoAuth, env.unsafeNoAuth ?? false);
    const hostIsLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
    // Require auth whenever the server is (or intends to be) reachable beyond
    // loopback. A reverse proxy keeps the bind on 127.0.0.1, so --remote is the
    // signal for the tunnel case; a non-loopback bind also implies remote.
    const requireAuth = !unsafeNoAuth && (remoteIntent || explicitRequireAuth || !hostIsLoopback);

    const config: ServerConfigShape = {
      logLevel,
      mode,
      port,
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      host,
      staticDir,
      devUrl,
      noBrowser,
      authToken,
      requireAuth,
      unsafeNoAuth,
      autoBootstrapProjectFromCwd,
      logWebSocketEvents,
    };

    return config;
  });

const commandFlags = {
  mode: modeFlag,
  port: portFlag,
  host: hostFlag,
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
  noBrowser: noBrowserFlag,
  authToken: authTokenFlag,
  remote: remoteFlag,
  requireAuth: requireAuthFlag,
  unsafeNoAuth: unsafeNoAuthFlag,
  bootstrapFd: bootstrapFdFlag,
  autoBootstrapProjectFromCwd: autoBootstrapProjectFromCwdFlag,
  logWebSocketEvents: logWebSocketEventsFlag,
} as const;

const runServerWithFlags = (flags: CliServerFlags) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveServerConfig(flags, logLevel);
    return yield* runServer.pipe(Effect.provideService(ServerConfig, config));
  });

const serveCommand = Command.make("serve", commandFlags).pipe(
  Command.withDescription("Run the ShioriCode server in the foreground."),
  Command.withHandler(runServerWithFlags),
);

const serviceActionCommand = (action: ServiceAction, description: string) =>
  Command.make(action).pipe(
    Command.withDescription(description),
    Command.withHandler(() =>
      Effect.promise(async () => {
        console.log(await controlService(action));
      }),
    ),
  );

const serviceCommand = Command.make("service").pipe(
  Command.withDescription("Install and control the OS background service."),
  Command.withSubcommands([
    Command.make("install").pipe(
      Command.withDescription("Install and start ShioriCode under a dedicated OS account."),
      Command.withHandler(() =>
        Effect.promise(async () => {
          const result = await installService();
          console.log("ShioriCode service installed and started.\n");
          console.log(serviceSummary(result.layout));
          console.log("\nLocal recovery credentials (store these securely):");
          console.log(`Username: ${result.recoveryUsername}`);
          console.log(`Password: ${result.recoveryPassword}`);
          console.log("\nNext: shioricode link connect");
        }),
      ),
    ),
    serviceActionCommand("start", "Start the ShioriCode service."),
    serviceActionCommand("stop", "Stop the ShioriCode service."),
    serviceActionCommand("restart", "Restart the ShioriCode service."),
    serviceActionCommand("status", "Show service status."),
    serviceActionCommand("logs", "Print the latest service logs."),
    serviceActionCommand("uninstall", "Remove the service while preserving data."),
  ]),
);

const linkNameFlag = Flag.string("name").pipe(
  Flag.withDescription("Human-readable name for this server in your Shiori account."),
  Flag.optional,
);

const linkCommand = Command.make("link").pipe(
  Command.withDescription("Connect and control ShioriCode Link hosting."),
  Command.withSubcommands([
    Command.make("connect", { name: linkNameFlag }).pipe(
      Command.withDescription("Sign in with GitHub and publish this server through Link."),
      Command.withHandler(({ name }) =>
        Effect.promise(async () => {
          const endpoint = await connectLinkEnvironment(Option.getOrElse(name, () => ""));
          console.log(`\nLink hosting is ready:\n${endpoint}`);
        }),
      ),
    ),
    Command.make("status").pipe(
      Command.withDescription("Show the Link connection configured for this service."),
      Command.withHandler(() => Effect.sync(() => console.log(linkStatus()))),
    ),
    Command.make("list").pipe(
      Command.withDescription("List named Link environments on the connected GitHub account."),
      Command.withHandler(() =>
        Effect.promise(async () => console.log(await listLinkEnvironments())),
      ),
    ),
    Command.make("disconnect").pipe(
      Command.withDescription("Revoke this Link environment and unlink GitHub."),
      Command.withHandler(() =>
        Effect.promise(async () => console.log(await disconnectLinkEnvironment())),
      ),
    ),
  ]),
);

const openCommand = Command.make("open", {
  directory: Argument.directory("directory", { mustExist: true }).pipe(Argument.optional),
  baseDir: baseDirFlag,
}).pipe(
  Command.withDescription(
    "Open a directory in ShioriCode Desktop, falling back to the local web UI.",
  ),
  Command.withHandler(({ directory, baseDir }) =>
    Effect.promise(async () => {
      const resolvedDirectory = Option.getOrUndefined(directory);
      const resolvedBaseDir = Option.getOrUndefined(baseDir);
      const result = await openShioriCodeDirectory({
        ...(resolvedDirectory === undefined ? {} : { directory: resolvedDirectory }),
        ...(resolvedBaseDir === undefined ? {} : { baseDir: resolvedBaseDir }),
      });
      console.log(
        `Opened ${result.directory} in ShioriCode ${result.target === "desktop" ? "Desktop" : "Web"}.`,
      );
    }),
  ),
);

const remoteStatusCommand = Command.make("status", { baseDir: baseDirFlag }).pipe(
  Command.withDescription("Show the active remote access method and reachable URL."),
  Command.withHandler(({ baseDir }) =>
    Effect.promise(async () => {
      console.log(await remoteStatus(Option.getOrUndefined(baseDir)));
    }),
  ),
);

const remoteExposureCommand = (
  name: "serve" | "funnel",
  method: "tailscale-serve" | "tailscale-funnel",
  description: string,
) =>
  Command.make(name, { baseDir: baseDirFlag }).pipe(
    Command.withDescription(description),
    Command.withHandler(({ baseDir }) =>
      Effect.promise(async () => {
        console.log(await setRemoteExposure(method, Option.getOrUndefined(baseDir)));
      }),
    ),
  );

const remoteCommand = Command.make("remote").pipe(
  Command.withDescription("Configure remote access to this ShioriCode server."),
  Command.withSubcommands([
    remoteStatusCommand,
    Command.make("tailscale").pipe(
      Command.withDescription("Expose ShioriCode through your existing Tailscale installation."),
      Command.withSubcommands([
        remoteExposureCommand(
          "serve",
          "tailscale-serve",
          "Make ShioriCode private to devices on your tailnet.",
        ),
        remoteExposureCommand(
          "funnel",
          "tailscale-funnel",
          "Publish ShioriCode through a public Tailscale Funnel URL.",
        ),
      ]),
    ),
    Command.make("off", { baseDir: baseDirFlag }).pipe(
      Command.withDescription("Disable the currently configured remote exposure."),
      Command.withHandler(({ baseDir }) =>
        Effect.promise(async () => {
          console.log(await setRemoteExposure("off", Option.getOrUndefined(baseDir)));
        }),
      ),
    ),
  ]),
);

const rootCommand = Command.make("shioricode", commandFlags).pipe(
  Command.withDescription("Run the ShioriCode server."),
  Command.withHandler(runServerWithFlags),
  Command.withSubcommands([
    serveCommand,
    openCommand,
    serviceCommand,
    linkCommand,
    remoteCommand,
    Command.make("doctor").pipe(
      Command.withDescription("Check provider CLIs and authentication in the service account."),
      Command.withHandler(() => Effect.promise(async () => console.log(await providerDoctor()))),
    ),
    Command.make("browser-panel-mcp").pipe(
      Command.withDescription("Run the built-in browser panel MCP server over stdio."),
      Command.withHandler(() => Effect.promise(() => runBrowserPanelMcpServer())),
    ),
    Command.make("computer-use-mcp").pipe(
      Command.withDescription("Run the macOS Computer Use MCP server over stdio."),
      Command.withHandler(() => Effect.promise(() => runComputerUseMcpServer())),
    ),
    Command.make("thread-goal-mcp").pipe(
      Command.withDescription("Run the built-in thread-goal MCP server over stdio."),
      Command.withHandler(() => Effect.promise(() => runThreadGoalMcpServer())),
    ),
  ]),
);

export const cli = rootCommand;
