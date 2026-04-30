import {
  type OnboardingCompleteStepInput,
  type NativeApi,
  ORCHESTRATION_WS_METHODS,
  type ServerSettingsPatch,
  type TelemetryCaptureInput,
  type TelemetryLogInput,
  WsRpcGroup,
  WS_METHODS,
} from "contracts";
import { Duration, Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);

type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;

type RpcTag = keyof WsRpcProtocolClient & string;
type RpcMethod<TTag extends RpcTag> = WsRpcProtocolClient[TTag];
type RpcInput<TTag extends RpcTag> = Parameters<RpcMethod<TTag>>[0];

type RpcUnaryMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? (input: RpcInput<TTag>) => Promise<TSuccess>
    : never;

type RpcUnaryNoArgMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? () => Promise<TSuccess>
    : never;

type RpcStreamMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer TEvent, any, any>
    ? (listener: (event: TEvent) => void) => () => void
    : never;

interface SubscribeOptions {
  readonly retryDelay?: Duration.Input;
}

const DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS = Duration.millis(250);

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

export function createWsRpcProtocolLayer(url: string) {
  const socketLayer = Socket.layerWebSocket(url).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );

  return RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
    Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)),
  );
}

export class WsTransport {
  private readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
  private readonly clientScope: Scope.Closeable;
  private readonly clientPromise: Promise<WsRpcProtocolClient>;
  private disposed = false;

  constructor(url: string) {
    this.runtime = ManagedRuntime.make(createWsRpcProtocolLayer(url));
    this.clientScope = this.runtime.runSync(Scope.make());
    this.clientPromise = this.runtime.runPromise(
      Scope.provide(this.clientScope)(makeWsRpcProtocolClient),
    );
  }

  async request<TSuccess>(
    execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
  ): Promise<TSuccess> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    const client = await this.clientPromise;
    return await this.runtime.runPromise(Effect.suspend(() => execute(client)));
  }

  subscribe<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    options?: SubscribeOptions,
  ): () => void {
    if (this.disposed) {
      return () => undefined;
    }

    let active = true;
    const retryDelayMs = options?.retryDelay ?? DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS;
    const cancel = this.runtime.runCallback(
      Effect.promise(() => this.clientPromise).pipe(
        Effect.flatMap((client) =>
          Stream.runForEach(connect(client), (value) =>
            Effect.sync(() => {
              if (!active) {
                return;
              }
              try {
                listener(value);
              } catch {
                // Listener errors should not kill the socket subscription.
              }
            }),
          ),
        ),
        Effect.catch((error) => {
          if (!active || this.disposed) {
            return Effect.interrupt;
          }
          return Effect.sync(() => {
            console.warn("WebSocket RPC subscription disconnected", {
              error: formatErrorMessage(error),
            });
          }).pipe(Effect.andThen(Effect.sleep(retryDelayMs)));
        }),
        Effect.forever,
      ),
    );

    return () => {
      active = false;
      cancel();
    };
  }

  async dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.runtime.runPromise(Scope.close(this.clientScope, Exit.void)).finally(() => {
      this.runtime.dispose();
    });
  }
}

export interface WsRpcClient {
  readonly dispose: () => Promise<void>;
  readonly terminal: {
    readonly open: RpcUnaryMethod<typeof WS_METHODS.terminalOpen>;
    readonly write: RpcUnaryMethod<typeof WS_METHODS.terminalWrite>;
    readonly resize: RpcUnaryMethod<typeof WS_METHODS.terminalResize>;
    readonly clear: RpcUnaryMethod<typeof WS_METHODS.terminalClear>;
    readonly restart: RpcUnaryMethod<typeof WS_METHODS.terminalRestart>;
    readonly close: RpcUnaryMethod<typeof WS_METHODS.terminalClose>;
    readonly onEvent: RpcStreamMethod<typeof WS_METHODS.subscribeTerminalEvents>;
  };
  readonly projects: {
    readonly searchEntries: RpcUnaryMethod<typeof WS_METHODS.projectsSearchEntries>;
    readonly writeFile: RpcUnaryMethod<typeof WS_METHODS.projectsWriteFile>;
  };
  readonly shell: {
    readonly openInEditor: (input: {
      readonly cwd: Parameters<NativeApi["shell"]["openInEditor"]>[0];
      readonly editor: Parameters<NativeApi["shell"]["openInEditor"]>[1];
    }) => ReturnType<NativeApi["shell"]["openInEditor"]>;
  };
  readonly git: {
    readonly status: RpcUnaryMethod<typeof WS_METHODS.gitStatus>;
    readonly listBranches: RpcUnaryMethod<typeof WS_METHODS.gitListBranches>;
    readonly createWorktree: RpcUnaryMethod<typeof WS_METHODS.gitCreateWorktree>;
    readonly removeWorktree: RpcUnaryMethod<typeof WS_METHODS.gitRemoveWorktree>;
    readonly createBranch: RpcUnaryMethod<typeof WS_METHODS.gitCreateBranch>;
    readonly checkout: RpcUnaryMethod<typeof WS_METHODS.gitCheckout>;
    readonly init: RpcUnaryMethod<typeof WS_METHODS.gitInit>;
    readonly resolvePullRequest: RpcUnaryMethod<typeof WS_METHODS.gitResolvePullRequest>;
    readonly preparePullRequestThread: RpcUnaryMethod<
      typeof WS_METHODS.gitPreparePullRequestThread
    >;
    readonly listOpenPullRequests: RpcUnaryMethod<typeof WS_METHODS.gitListOpenPullRequests>;
    readonly getPullRequestDiff: RpcUnaryMethod<typeof WS_METHODS.gitGetPullRequestDiff>;
    readonly summarizePullRequest: RpcUnaryMethod<typeof WS_METHODS.gitSummarizePullRequest>;
    readonly getPullRequestConversation: RpcUnaryMethod<
      typeof WS_METHODS.gitGetPullRequestConversation
    >;
  };
  readonly server: {
    readonly getConfig: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetConfig>;
    readonly refreshProviders: RpcUnaryNoArgMethod<typeof WS_METHODS.serverRefreshProviders>;
    readonly upsertKeybinding: RpcUnaryMethod<typeof WS_METHODS.serverUpsertKeybinding>;
    readonly getSettings: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetSettings>;
    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => ReturnType<RpcUnaryMethod<typeof WS_METHODS.serverUpdateSettings>>;
    readonly listMcpServers: RpcUnaryNoArgMethod<typeof WS_METHODS.serverListMcpServers>;
    readonly authenticateMcpServer: RpcUnaryMethod<typeof WS_METHODS.serverAuthenticateMcpServer>;
    readonly removeMcpServer: RpcUnaryMethod<typeof WS_METHODS.serverRemoveMcpServer>;
    readonly listSkills: RpcUnaryNoArgMethod<typeof WS_METHODS.serverListSkills>;
    readonly removeSkill: RpcUnaryMethod<typeof WS_METHODS.serverRemoveSkill>;
    readonly setShioriAuthToken: (token: string | null) => Promise<void>;
    readonly getProviderUsage: RpcUnaryMethod<typeof WS_METHODS.serverGetProviderUsage>;
    readonly getHostedBillingSnapshot: RpcUnaryNoArgMethod<
      typeof WS_METHODS.serverGetHostedBillingSnapshot
    >;
    readonly createHostedBillingCheckout: RpcUnaryMethod<
      typeof WS_METHODS.serverCreateHostedBillingCheckout
    >;
    readonly createHostedBillingPortal: RpcUnaryMethod<
      typeof WS_METHODS.serverCreateHostedBillingPortal
    >;
    readonly hostedOAuthStart: RpcUnaryMethod<typeof WS_METHODS.serverHostedOAuthStart>;
    readonly hostedPasswordAuth: RpcUnaryMethod<typeof WS_METHODS.serverHostedPasswordAuth>;
    readonly subscribeConfig: RpcStreamMethod<typeof WS_METHODS.subscribeServerConfig>;
    readonly subscribeLifecycle: RpcStreamMethod<typeof WS_METHODS.subscribeServerLifecycle>;
  };
  readonly onboarding: {
    readonly getState: RpcUnaryNoArgMethod<typeof WS_METHODS.onboardingGetState>;
    readonly completeStep: (
      input: OnboardingCompleteStepInput,
    ) => ReturnType<RpcUnaryMethod<typeof WS_METHODS.onboardingCompleteStep>>;
    readonly reset: RpcUnaryNoArgMethod<typeof WS_METHODS.onboardingReset>;
  };
  readonly telemetry: {
    readonly capture: (input: TelemetryCaptureInput) => Promise<void>;
    readonly log: (input: TelemetryLogInput) => Promise<void>;
  };
  readonly orchestration: {
    readonly getSnapshot: RpcUnaryNoArgMethod<typeof ORCHESTRATION_WS_METHODS.getSnapshot>;
    readonly dispatchCommand: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.dispatchCommand>;
    readonly getTurnDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getTurnDiff>;
    readonly getFullThreadDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getFullThreadDiff>;
    readonly getSubagentDetail: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getSubagentDetail>;
    readonly replayEvents: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.replayEvents>;
    readonly onDomainEvent: RpcStreamMethod<typeof WS_METHODS.subscribeOrchestrationDomainEvents>;
  };
  readonly browserPanel: {
    readonly completeCommand: RpcUnaryMethod<typeof WS_METHODS.browserPanelCompleteCommand>;
    readonly onNavigateRequest: RpcStreamMethod<typeof WS_METHODS.subscribeBrowserPanelCommands>;
  };
}

export function createWsRpcClient(options: {
  readonly transport?: WsTransport;
  readonly url?: string;
}): WsRpcClient {
  const transport = options.transport ?? new WsTransport(requiredUrl(options.url));

  return {
    dispose: () => transport.dispose(),
    terminal: {
      open: (input) => transport.request((client) => client[WS_METHODS.terminalOpen](input)),
      write: (input) => transport.request((client) => client[WS_METHODS.terminalWrite](input)),
      resize: (input) => transport.request((client) => client[WS_METHODS.terminalResize](input)),
      clear: (input) => transport.request((client) => client[WS_METHODS.terminalClear](input)),
      restart: (input) => transport.request((client) => client[WS_METHODS.terminalRestart](input)),
      close: (input) => transport.request((client) => client[WS_METHODS.terminalClose](input)),
      onEvent: (listener) =>
        transport.subscribe((client) => client[WS_METHODS.subscribeTerminalEvents]({}), listener),
    },
    projects: {
      searchEntries: (input) =>
        transport.request((client) => client[WS_METHODS.projectsSearchEntries](input)),
      writeFile: (input) =>
        transport.request((client) => client[WS_METHODS.projectsWriteFile](input)),
    },
    shell: {
      openInEditor: (input) =>
        transport.request((client) => client[WS_METHODS.shellOpenInEditor](input)),
    },
    git: {
      status: (input) => transport.request((client) => client[WS_METHODS.gitStatus](input)),
      listBranches: (input) =>
        transport.request((client) => client[WS_METHODS.gitListBranches](input)),
      createWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.gitCreateWorktree](input)),
      removeWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.gitRemoveWorktree](input)),
      createBranch: (input) =>
        transport.request((client) => client[WS_METHODS.gitCreateBranch](input)),
      checkout: (input) => transport.request((client) => client[WS_METHODS.gitCheckout](input)),
      init: (input) => transport.request((client) => client[WS_METHODS.gitInit](input)),
      resolvePullRequest: (input) =>
        transport.request((client) => client[WS_METHODS.gitResolvePullRequest](input)),
      preparePullRequestThread: (input) =>
        transport.request((client) => client[WS_METHODS.gitPreparePullRequestThread](input)),
      listOpenPullRequests: (input) =>
        transport.request((client) => client[WS_METHODS.gitListOpenPullRequests](input)),
      getPullRequestDiff: (input) =>
        transport.request((client) => client[WS_METHODS.gitGetPullRequestDiff](input)),
      summarizePullRequest: (input) =>
        transport.request((client) => client[WS_METHODS.gitSummarizePullRequest](input)),
      getPullRequestConversation: (input) =>
        transport.request((client) => client[WS_METHODS.gitGetPullRequestConversation](input)),
    },
    server: {
      getConfig: () => transport.request((client) => client[WS_METHODS.serverGetConfig]({})),
      refreshProviders: () =>
        transport.request((client) => client[WS_METHODS.serverRefreshProviders]({})),
      upsertKeybinding: (input) =>
        transport.request((client) => client[WS_METHODS.serverUpsertKeybinding](input)),
      getSettings: () => transport.request((client) => client[WS_METHODS.serverGetSettings]({})),
      updateSettings: (patch) =>
        transport.request((client) => client[WS_METHODS.serverUpdateSettings]({ patch })),
      listMcpServers: () =>
        transport.request((client) => client[WS_METHODS.serverListMcpServers]({})),
      authenticateMcpServer: (input) =>
        transport.request((client) => client[WS_METHODS.serverAuthenticateMcpServer](input)),
      removeMcpServer: (input) =>
        transport.request((client) => client[WS_METHODS.serverRemoveMcpServer](input)),
      listSkills: () => transport.request((client) => client[WS_METHODS.serverListSkills]({})),
      removeSkill: (input) =>
        transport.request((client) => client[WS_METHODS.serverRemoveSkill](input)),
      setShioriAuthToken: (token) =>
        transport
          .request((client) => client[WS_METHODS.serverSetShioriAuthToken]({ token }))
          .then(() => undefined),
      getProviderUsage: (input) =>
        transport.request((client) => client[WS_METHODS.serverGetProviderUsage](input)),
      getHostedBillingSnapshot: () =>
        transport.request((client) => client[WS_METHODS.serverGetHostedBillingSnapshot]({})),
      createHostedBillingCheckout: (input) =>
        transport.request((client) => client[WS_METHODS.serverCreateHostedBillingCheckout](input)),
      createHostedBillingPortal: (input) =>
        transport.request((client) => client[WS_METHODS.serverCreateHostedBillingPortal](input)),
      hostedOAuthStart: (input) =>
        transport.request((client) => client[WS_METHODS.serverHostedOAuthStart](input)),
      hostedPasswordAuth: (input) =>
        transport.request((client) => client[WS_METHODS.serverHostedPasswordAuth](input)),
      subscribeConfig: (listener) =>
        transport.subscribe((client) => client[WS_METHODS.subscribeServerConfig]({}), listener),
      subscribeLifecycle: (listener) =>
        transport.subscribe((client) => client[WS_METHODS.subscribeServerLifecycle]({}), listener),
    },
    onboarding: {
      getState: () => transport.request((client) => client[WS_METHODS.onboardingGetState]({})),
      completeStep: (input) =>
        transport.request((client) => client[WS_METHODS.onboardingCompleteStep](input)),
      reset: () => transport.request((client) => client[WS_METHODS.onboardingReset]({})),
    },
    telemetry: {
      capture: (input) =>
        transport
          .request((client) => client[WS_METHODS.telemetryCapture](input))
          .then(() => undefined),
      log: (input) =>
        transport.request((client) => client[WS_METHODS.telemetryLog](input)).then(() => undefined),
    },
    orchestration: {
      getSnapshot: () =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getSnapshot]({})),
      dispatchCommand: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.dispatchCommand](input)),
      getTurnDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getTurnDiff](input)),
      getFullThreadDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getFullThreadDiff](input)),
      getSubagentDetail: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getSubagentDetail](input)),
      replayEvents: (input) =>
        transport
          .request((client) => client[ORCHESTRATION_WS_METHODS.replayEvents](input))
          .then((events) => [...events]),
      onDomainEvent: (listener) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeOrchestrationDomainEvents]({}),
          listener,
        ),
    },
    browserPanel: {
      completeCommand: (input) =>
        transport.request((client) => client[WS_METHODS.browserPanelCompleteCommand](input)),
      onNavigateRequest: (listener) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeBrowserPanelCommands]({}),
          listener,
        ),
    },
  };
}

function requiredUrl(url: string | undefined): string {
  if (!url || url.trim().length === 0) {
    throw new Error("WebSocket RPC URL is required.");
  }
  return url;
}
