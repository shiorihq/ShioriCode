import { randomBytes, randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CommandId,
  MessageId,
  MobileCommand,
  type MobileCommand as MobileCommandShape,
  type MobileCommandResult,
  type MobileProvider,
  MobilePairRequest,
  type MobilePairRequest as MobilePairRequestShape,
  type MobilePairResult,
  type MobilePairingCandidate,
  type MobilePairingPayload,
  type MobilePairingSession,
  type MobilePairingSessionStatus,
  type MobilePendingApproval,
  type MobilePendingUserInput,
  type MobileSnapshot,
  type ModelSelection,
  PROVIDER_DISPLAY_NAMES,
  ProjectId,
  type ServerProvider,
  ThreadId,
  type OrchestrationReadModel,
} from "contracts";
import { Data, Effect, Layer, Option, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { derivePendingApprovals, derivePendingUserInputs } from "shared/orchestrationSession";

import { ServerConfig, type ServerConfigShape } from "./config";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";
import { ServerSettingsService } from "./serverSettings";

const PAIRING_SESSION_TTL_MS = 5 * 60 * 1000;
const DEVICE_TOKEN_BYTES = 32;
const MOBILE_DEVICES_FILE = "mobile-devices.json";
const MOBILE_DISABLED_MESSAGE = "ShioriCode mobile app is disabled.";

class MobileRouteError extends Data.TaggedError("MobileRouteError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function mobileRouteError(message: string, cause: unknown) {
  return new MobileRouteError({ message, cause });
}

const CORS_HEADERS = {
  "Access-Control-Allow-Headers": "authorization,content-type,x-shioricode-device-id",
  "Access-Control-Allow-Methods": "DELETE,GET,OPTIONS,POST",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
} as const;

interface PairingSessionRecord {
  readonly pairingId: string;
  readonly pairingSecretHash: string;
  readonly expiresAt: string;
  pairedDeviceName: string | null;
  pairedAt: string | null;
}

interface StoredMobileDevice {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly tokenHash: string;
  readonly pairedAt: string;
  lastSeenAt: string;
}

interface MobileDeviceStoreFile {
  readonly version: 1;
  devices: StoredMobileDevice[];
}

const pairingSessions = new Map<string, PairingSessionRecord>();
const deviceStoreByStateDir = new Map<string, Promise<MobileDeviceStoreFile>>();

function jsonResponse(body: unknown, status = 200) {
  return HttpServerResponse.text(`${JSON.stringify(body)}\n`, {
    status,
    contentType: "application/json",
    headers: CORS_HEADERS,
  });
}

function successResponse<T>(data: T, status = 200) {
  return jsonResponse({ success: true, data }, status);
}

function errorResponse(error: string, status = 400) {
  return jsonResponse({ success: false, error }, status);
}

function routeErrorStatus(error: Error, fallback: number): number {
  return error.message === MOBILE_DISABLED_MESSAGE ? 403 : fallback;
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function timingSafeHashEquals(left: string, right: string): boolean {
  return left.length === right.length && left === right;
}

function createSecret(byteLength = DEVICE_TOKEN_BYTES): string {
  return randomBytes(byteLength).toString("base64url");
}

function normalizeDeviceName(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return "iPhone";
  }
  return trimmed.slice(0, 80);
}

function mobileDevicesPath(config: ServerConfigShape): string {
  return path.join(config.stateDir, MOBILE_DEVICES_FILE);
}

async function readDeviceStore(config: ServerConfigShape): Promise<MobileDeviceStoreFile> {
  const cached = deviceStoreByStateDir.get(config.stateDir);
  if (cached) {
    return cached;
  }

  const promise = fs
    .readFile(mobileDevicesPath(config), "utf8")
    .then((raw): MobileDeviceStoreFile => {
      const parsed = JSON.parse(raw) as Partial<MobileDeviceStoreFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.devices)) {
        return { version: 1, devices: [] };
      }
      return {
        version: 1,
        devices: parsed.devices.filter(
          (device): device is StoredMobileDevice =>
            typeof device?.deviceId === "string" &&
            typeof device.deviceName === "string" &&
            typeof device.tokenHash === "string" &&
            typeof device.pairedAt === "string" &&
            typeof device.lastSeenAt === "string",
        ),
      };
    })
    .catch((): MobileDeviceStoreFile => ({ version: 1, devices: [] }));

  deviceStoreByStateDir.set(config.stateDir, promise);
  return promise;
}

async function writeDeviceStore(
  config: ServerConfigShape,
  store: MobileDeviceStoreFile,
): Promise<void> {
  await fs.mkdir(config.stateDir, { recursive: true });
  await fs.writeFile(mobileDevicesPath(config), `${JSON.stringify(store, null, 2)}\n`);
  deviceStoreByStateDir.set(config.stateDir, Promise.resolve(store));
}

function getBearerToken(request: HttpServerRequest.HttpServerRequest, url: URL): string | null {
  const queryToken = url.searchParams.get("token");
  if (queryToken) {
    return queryToken;
  }

  const authorization = request.headers.authorization;
  if (!authorization) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || null;
}

function isDesktopAuthorized(input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly url: URL;
  readonly config: ServerConfigShape;
}): boolean {
  if (!input.config.authToken) {
    return true;
  }
  return getBearerToken(input.request, input.url) === input.config.authToken;
}

async function authorizeMobileDevice(input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly url: URL;
  readonly config: ServerConfigShape;
}): Promise<StoredMobileDevice | null> {
  const deviceId =
    input.request.headers["x-shioricode-device-id"] ?? input.url.searchParams.get("deviceId");
  const token = getBearerToken(input.request, input.url);
  if (!deviceId || !token) {
    return null;
  }

  const store = await readDeviceStore(input.config);
  const device = store.devices.find((entry) => entry.deviceId === deviceId);
  if (!device || !timingSafeHashEquals(device.tokenHash, hashSecret(token))) {
    return null;
  }

  device.lastSeenAt = new Date().toISOString();
  await writeDeviceStore(input.config, store);
  return device;
}

function requestUrl(request: HttpServerRequest.HttpServerRequest): URL | null {
  const url = HttpServerRequest.toURL(request);
  return Option.isSome(url) ? url.value : null;
}

const decodeJson = Effect.fn(function* <A>(
  request: HttpServerRequest.HttpServerRequest,
  schema: Schema.Schema<A>,
  message: string,
): Effect.fn.Return<A, MobileRouteError> {
  const body = yield* request.json.pipe(
    Effect.mapError((cause) => mobileRouteError(message, cause)),
  );
  return yield* Effect.try({
    try: () => Schema.decodeUnknownSync(schema as never)(body) as A,
    catch: (cause) => mobileRouteError(message, cause),
  });
});

function addCandidate(
  candidates: MobilePairingCandidate[],
  seen: Set<string>,
  apiBaseUrl: string,
  label: string,
) {
  if (seen.has(apiBaseUrl)) {
    return;
  }
  seen.add(apiBaseUrl);
  candidates.push({ apiBaseUrl, label });
}

function isLoopbackHost(host: string | undefined): boolean {
  return host === undefined || host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isWildcardHost(host: string | undefined): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

function mobilePairingCandidates(config: ServerConfigShape, url: URL): MobilePairingCandidate[] {
  const candidates: MobilePairingCandidate[] = [];
  const seen = new Set<string>();
  const port = config.port;
  const acceptsLanConnections = isWildcardHost(config.host) || !isLoopbackHost(config.host);

  addCandidate(candidates, seen, `http://127.0.0.1:${port}`, "Simulator on this Mac");

  const requestHost = url.hostname;
  if (
    acceptsLanConnections &&
    requestHost &&
    requestHost !== "127.0.0.1" &&
    requestHost !== "localhost"
  ) {
    addCandidate(candidates, seen, `http://${requestHost}:${port}`, "Current desktop address");
  }

  if (acceptsLanConnections) {
    for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.family !== "IPv4" || address.internal) {
          continue;
        }
        addCandidate(candidates, seen, `http://${address.address}:${port}`, name);
      }
    }
  }

  return candidates;
}

function pruneExpiredPairingSessions(now = Date.now()) {
  for (const [pairingId, session] of pairingSessions) {
    if (Date.parse(session.expiresAt) <= now) {
      pairingSessions.delete(pairingId);
    }
  }
}

function createPairingSession(config: ServerConfigShape, url: URL): MobilePairingSession {
  pruneExpiredPairingSessions();

  const pairingId = randomUUID();
  const pairingSecret = createSecret(24);
  const expiresAt = new Date(Date.now() + PAIRING_SESSION_TTL_MS).toISOString();
  const candidates = mobilePairingCandidates(config, url);
  const payload: MobilePairingPayload = {
    version: 1,
    kind: "shioricode.mobilePair",
    pairingId,
    pairingSecret,
    expiresAt,
    apiBaseUrls: candidates.map((candidate) => candidate.apiBaseUrl),
    candidates,
  };

  pairingSessions.set(pairingId, {
    pairingId,
    pairingSecretHash: hashSecret(pairingSecret),
    expiresAt,
    pairedDeviceName: null,
    pairedAt: null,
  });

  return {
    pairingId,
    expiresAt,
    qrPayload: JSON.stringify(payload),
    candidates,
  };
}

function findValidPairingSession(pairingId: string, pairingSecret: string): PairingSessionRecord {
  pruneExpiredPairingSessions();

  const session = pairingSessions.get(pairingId);
  if (!session) {
    throw new Error("Pairing session expired. Create a new QR code.");
  }
  if (!timingSafeHashEquals(session.pairingSecretHash, hashSecret(pairingSecret))) {
    throw new Error("Pairing code did not match this desktop.");
  }
  if (session.pairedAt !== null) {
    throw new Error("Pairing code has already been used.");
  }
  return session;
}

async function pairDevice(
  config: ServerConfigShape,
  input: MobilePairRequestShape,
): Promise<MobilePairResult> {
  const session = findValidPairingSession(input.pairingId, input.pairingSecret);
  const now = new Date().toISOString();
  const deviceId = randomUUID();
  const token = createSecret();
  const deviceName = normalizeDeviceName(input.deviceName);
  const store = await readDeviceStore(config);

  store.devices = [
    ...store.devices.filter((device) => device.deviceName !== deviceName),
    {
      deviceId,
      deviceName,
      tokenHash: hashSecret(token),
      pairedAt: now,
      lastSeenAt: now,
    },
  ];
  await writeDeviceStore(config, store);

  session.pairedAt = now;
  session.pairedDeviceName = deviceName;

  return {
    deviceId,
    token,
    deviceName,
    pairedAt: now,
  };
}

function pairingSessionStatus(pairingId: string): MobilePairingSessionStatus | null {
  pruneExpiredPairingSessions();
  const session = pairingSessions.get(pairingId);
  if (!session) {
    return null;
  }
  return {
    pairingId: session.pairingId,
    expiresAt: session.expiresAt,
    paired: session.pairedAt !== null,
    pairedDeviceName: session.pairedDeviceName,
    pairedAt: session.pairedAt,
  };
}

function previewText(text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function toMobileProviders(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<MobileProvider> {
  return providers.map((entry) => ({
    provider: entry.provider,
    displayName: PROVIDER_DISPLAY_NAMES[entry.provider],
    enabled: entry.enabled,
    installed: entry.installed,
    status: entry.status,
    models: entry.models.map((model) =>
      Object.assign(
        {
          slug: model.slug,
          name: model.name,
          isCustom: model.isCustom,
          capabilities: model.capabilities,
        },
        model.shortName ? { shortName: model.shortName } : {},
        model.multiModal !== undefined ? { multiModal: model.multiModal } : {},
      ),
    ),
  }));
}

function resolveDefaultModelSelection(
  readModel: OrchestrationReadModel,
  serverDefault: ModelSelection | null,
): ModelSelection | null {
  return (
    serverDefault ??
    readModel.projects.find((project) => project.defaultModelSelection)?.defaultModelSelection ??
    null
  );
}

function toMobileSnapshot(
  readModel: OrchestrationReadModel,
  providers: ReadonlyArray<ServerProvider>,
  defaultModelSelection: ModelSelection | null,
): MobileSnapshot {
  const projects = readModel.projects
    .filter((project) => project.deletedAt === null)
    .map((project) => ({
      id: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
    }));

  const liveThreads = readModel.threads.filter((thread) => thread.deletedAt === null);
  const threadDetails = liveThreads.map((thread) => {
    const pendingApprovals = derivePendingApprovals(thread.activities).map(
      (approval): MobilePendingApproval =>
        Object.assign(
          {
            requestId: approval.requestId,
            requestKind: approval.requestKind,
            createdAt: approval.createdAt,
          },
          approval.detail ? { detail: approval.detail } : {},
        ),
    );
    const pendingUserInputs = derivePendingUserInputs(thread.activities).map(
      (userInput): MobilePendingUserInput => ({
        requestId: userInput.requestId,
        questions: userInput.questions.map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          options: question.options.map((option) => ({
            label: option.label,
            description: option.description,
          })),
        })),
        createdAt: userInput.createdAt,
      }),
    );

    return {
      id: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      status: thread.session?.status ?? null,
      activeTurnId: thread.session?.activeTurnId ?? null,
      messages: thread.messages.map((message) => ({
        id: message.id,
        role: message.role,
        text: message.text,
        streaming: message.streaming,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      })),
      pendingApprovals,
      pendingUserInputs,
      updatedAt: thread.updatedAt,
    };
  });
  const detailByThreadId = new Map(threadDetails.map((thread) => [thread.id, thread]));

  const threads = liveThreads
    .map((thread) => {
      const detail = detailByThreadId.get(thread.id);
      const latestMessage = thread.messages.at(-1) ?? null;
      return {
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        status: thread.session?.status ?? null,
        activeTurnId: thread.session?.activeTurnId ?? null,
        latestMessagePreview: latestMessage ? previewText(latestMessage.text) : null,
        hasPendingApproval: (detail?.pendingApprovals.length ?? 0) > 0,
        hasPendingUserInput: (detail?.pendingUserInputs.length ?? 0) > 0,
        archivedAt: thread.archivedAt,
        updatedAt: thread.updatedAt,
      };
    })
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  return {
    version: 1,
    snapshotSequence: readModel.snapshotSequence,
    updatedAt: readModel.updatedAt,
    projects,
    threads,
    threadDetails,
    providers: toMobileProviders(providers),
    defaultModelSelection,
  };
}

function resolveThread(readModel: OrchestrationReadModel, threadId: ThreadId) {
  return readModel.threads.find((thread) => thread.id === threadId && thread.deletedAt === null);
}

function resolveProject(readModel: OrchestrationReadModel, projectId: ProjectId) {
  return readModel.projects.find(
    (project) => project.id === projectId && project.deletedAt === null,
  );
}

function normalizePromptText(text: string): string {
  return text.trim();
}

const dispatchMobileCommand = Effect.fn(function* (command: MobileCommandShape) {
  const engine = yield* OrchestrationEngineService;
  const startup = yield* ServerRuntimeStartup;
  const serverSettings = yield* ServerSettingsService;
  const now = new Date().toISOString();
  const commandId = CommandId.makeUnsafe(command.requestId);

  if (command.type === "thread.create") {
    const readModel = yield* engine.getReadModel();
    const project = resolveProject(readModel, command.projectId);
    if (!project) {
      return yield* Effect.fail(new Error("Project not found."));
    }

    const settings = yield* serverSettings.getSettings;
    const modelSelection =
      command.modelSelection ??
      project.defaultModelSelection ??
      settings.defaultModelSelection ??
      readModel.projects.find((entry) => entry.defaultModelSelection)?.defaultModelSelection ??
      null;
    if (!modelSelection) {
      return yield* Effect.fail(
        new Error("No default model is configured for new mobile threads."),
      );
    }

    const threadId = ThreadId.makeUnsafe(randomUUID());
    const createResult = yield* startup.enqueueCommand(
      engine.dispatch({
        type: "thread.create",
        commandId,
        threadId,
        projectId: project.id,
        title: normalizePromptText(command.title ?? "") || "New Thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    const initialMessage = normalizePromptText(command.initialMessage ?? "");
    if (!initialMessage) {
      return { sequence: createResult.sequence, threadId } satisfies MobileCommandResult;
    }

    const turnResult = yield* startup.enqueueCommand(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(`${command.requestId}:turn`),
        threadId,
        message: {
          messageId: MessageId.makeUnsafe(randomUUID()),
          role: "user",
          text: initialMessage,
          attachments: [],
        },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: now,
      }),
    );
    return { sequence: turnResult.sequence, threadId } satisfies MobileCommandResult;
  }

  const readModel = yield* engine.getReadModel();
  const thread = resolveThread(readModel, command.threadId);
  if (!thread) {
    return yield* Effect.fail(new Error("Thread not found."));
  }

  switch (command.type) {
    case "thread.turn.start": {
      const text = normalizePromptText(command.text);
      if (!text) {
        return yield* Effect.fail(new Error("Message cannot be empty."));
      }
      const result = yield* startup.enqueueCommand(
        engine.dispatch({
          type: "thread.turn.start",
          commandId,
          threadId: command.threadId,
          message: {
            messageId: MessageId.makeUnsafe(randomUUID()),
            role: "user",
            text,
            attachments: [],
          },
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: now,
        }),
      );
      return {
        sequence: result.sequence,
        threadId: command.threadId,
      } satisfies MobileCommandResult;
    }

    case "thread.turn.interrupt": {
      const result = yield* startup.enqueueCommand(
        engine.dispatch({
          type: "thread.turn.interrupt",
          commandId,
          threadId: command.threadId,
          createdAt: now,
        }),
      );
      return {
        sequence: result.sequence,
        threadId: command.threadId,
      } satisfies MobileCommandResult;
    }

    case "thread.approval.respond": {
      const result = yield* startup.enqueueCommand(
        engine.dispatch({
          type: "thread.approval.respond",
          commandId,
          threadId: command.threadId,
          requestId: command.requestIdToRespondTo,
          decision: command.decision,
          createdAt: now,
        }),
      );
      return {
        sequence: result.sequence,
        threadId: command.threadId,
      } satisfies MobileCommandResult;
    }

    case "thread.user-input.respond": {
      const result = yield* startup.enqueueCommand(
        engine.dispatch({
          type: "thread.user-input.respond",
          commandId,
          threadId: command.threadId,
          requestId: command.requestIdToRespondTo,
          answers: command.answers,
          createdAt: now,
        }),
      );
      return {
        sequence: result.sequence,
        threadId: command.threadId,
      } satisfies MobileCommandResult;
    }
  }
});

const requireUrl = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  if (!url) {
    return yield* Effect.fail(new Error("Invalid request URL."));
  }
  return { request, url };
});

const requireMobileEnabled = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings;
  if (!settings.mobileApp.enabled) {
    return yield* Effect.fail(new Error(MOBILE_DISABLED_MESSAGE));
  }
});

const requireDesktopAuth = Effect.gen(function* () {
  yield* requireMobileEnabled;
  const { request, url } = yield* requireUrl;
  const config = yield* ServerConfig;
  if (!isDesktopAuthorized({ request, url, config })) {
    return yield* Effect.fail(new Error("Unauthorized."));
  }
  return { request, url, config };
});

const requireMobileAuth = Effect.gen(function* () {
  yield* requireMobileEnabled;
  const { request, url } = yield* requireUrl;
  const config = yield* ServerConfig;
  const device = yield* Effect.promise(() => authorizeMobileDevice({ request, url, config }));
  if (!device) {
    return yield* Effect.fail(new Error("Unauthorized mobile device."));
  }
  return { request, url, config, device };
});

const mobileOptionsRouteLayer = HttpRouter.add(
  "OPTIONS",
  "/api/mobile/*",
  Effect.succeed(HttpServerResponse.empty({ status: 204, headers: CORS_HEADERS })),
);

const mobileCreatePairingSessionRouteLayer = HttpRouter.add(
  "POST",
  "/api/mobile/pairing-sessions",
  requireDesktopAuth.pipe(
    Effect.map(({ config, url }) => successResponse(createPairingSession(config, url))),
    Effect.catch((error) =>
      Effect.succeed(errorResponse(error.message, routeErrorStatus(error, 401))),
    ),
  ),
);

const mobilePairingSessionStatusRouteLayer = HttpRouter.add(
  "GET",
  "/api/mobile/pairing-sessions/status",
  requireDesktopAuth.pipe(
    Effect.map(({ url }) => {
      const pairingId = url.searchParams.get("pairingId");
      if (!pairingId) {
        return errorResponse("Missing pairingId.", 400);
      }
      const status = pairingSessionStatus(pairingId);
      if (!status) {
        return errorResponse("Pairing session not found.", 404);
      }
      return successResponse(status);
    }),
    Effect.catch((error) =>
      Effect.succeed(errorResponse(error.message, routeErrorStatus(error, 401))),
    ),
  ),
);

const mobileDeletePairingSessionRouteLayer = HttpRouter.add(
  "DELETE",
  "/api/mobile/pairing-sessions",
  requireDesktopAuth.pipe(
    Effect.map(({ url }) => {
      const pairingId = url.searchParams.get("pairingId");
      if (pairingId) {
        pairingSessions.delete(pairingId);
      }
      return successResponse({});
    }),
    Effect.catch((error) =>
      Effect.succeed(errorResponse(error.message, routeErrorStatus(error, 401))),
    ),
  ),
);

const mobilePairRouteLayer = HttpRouter.add(
  "POST",
  "/api/mobile/pair",
  Effect.gen(function* () {
    yield* requireMobileEnabled;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const input = yield* decodeJson(request, MobilePairRequest, "Invalid mobile pairing request.");
    const result = yield* Effect.promise(() => pairDevice(config, input));
    return successResponse(result);
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        error instanceof Error
          ? errorResponse(error.message, routeErrorStatus(error, 400))
          : errorResponse("Pairing failed.", 400),
      ),
    ),
  ),
);

const mobileSnapshotRouteLayer = HttpRouter.add(
  "GET",
  "/api/mobile/snapshot",
  requireMobileAuth.pipe(
    Effect.flatMap(() =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const providerRegistry = yield* ProviderRegistry;
        const serverSettings = yield* ServerSettingsService;
        const readModel = yield* engine.getReadModel();
        const providers = yield* providerRegistry.getProviders;
        const settings = yield* serverSettings.getSettings;
        const defaultModelSelection = resolveDefaultModelSelection(
          readModel,
          settings.defaultModelSelection ?? null,
        );
        return successResponse(toMobileSnapshot(readModel, providers, defaultModelSelection));
      }),
    ),
    Effect.catch((error) =>
      Effect.succeed(errorResponse(error.message, routeErrorStatus(error, 401))),
    ),
  ),
);

const mobileEventsRouteLayer = HttpRouter.add(
  "GET",
  "/api/mobile/events",
  requireMobileAuth.pipe(
    Effect.flatMap(({ url }) =>
      Effect.gen(function* () {
        const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
        const fromSequenceExclusive = Number.isFinite(after) && after >= 0 ? after : 0;
        const engine = yield* OrchestrationEngineService;
        const events = yield* Stream.runCollect(engine.readEvents(fromSequenceExclusive)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        return successResponse({
          events,
          latestSequence: events.at(-1)?.sequence ?? fromSequenceExclusive,
        });
      }),
    ),
    Effect.catch((error) =>
      Effect.succeed(errorResponse(error.message, routeErrorStatus(error, 401))),
    ),
  ),
);

const mobileCommandRouteLayer = HttpRouter.add(
  "POST",
  "/api/mobile/commands",
  requireMobileAuth.pipe(
    Effect.flatMap(({ request }) =>
      Effect.gen(function* () {
        const command = yield* decodeJson(request, MobileCommand, "Invalid mobile command.");
        const result = yield* dispatchMobileCommand(command);
        return successResponse(result);
      }),
    ),
    Effect.catch((error) =>
      Effect.succeed(
        error instanceof Error
          ? errorResponse(error.message, routeErrorStatus(error, 400))
          : errorResponse("Command failed.", 400),
      ),
    ),
  ),
);

export const mobileRoutesLayer = Layer.mergeAll(
  mobileOptionsRouteLayer,
  mobileCreatePairingSessionRouteLayer,
  mobilePairingSessionStatusRouteLayer,
  mobileDeletePairingSessionRouteLayer,
  mobilePairRouteLayer,
  mobileSnapshotRouteLayer,
  mobileEventsRouteLayer,
  mobileCommandRouteLayer,
);
