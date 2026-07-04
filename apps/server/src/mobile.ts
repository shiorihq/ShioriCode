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
  type MobileConnectionInfo,
  type MobileFileChange,
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
  ProjectSearchEntriesInput,
  type ServerProvider,
  ThreadId,
  type OrchestrationCheckpointSummary,
  type OrchestrationReadModel,
} from "contracts";
import { Data, Effect, Layer, Option, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { derivePendingApprovals, derivePendingUserInputs } from "shared/orchestrationSession";

import { EnvironmentAuth } from "./auth/EnvironmentAuth";
import { ServerConfig, type ServerConfigShape } from "./config";
import { normalizeDispatchCommand } from "./orchestration/Normalizer";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry";
import { detectTailscaleSelf, findTailscaleCli, readServe } from "./remote/tailscale";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";
import { ServerSettingsService } from "./serverSettings";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries";

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

function normalizeLocalHostname(hostname: string): string | null {
  const trimmed = hostname.trim().replace(/\.$/, "");
  if (!trimmed || isLoopbackHost(trimmed)) {
    return null;
  }
  return trimmed.endsWith(".local") ? trimmed : `${trimmed}.local`;
}

function isLoopbackHost(host: string | undefined): boolean {
  const normalized = host?.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return (
    normalized === undefined ||
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1"
  );
}

function isWildcardHost(host: string | undefined): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

function serverAcceptsNonLoopback(config: ServerConfigShape): boolean {
  return isWildcardHost(config.host) || !isLoopbackHost(config.host);
}

export function mobilePairingCandidates(
  config: ServerConfigShape,
  url: URL,
  extraCandidates: ReadonlyArray<MobilePairingCandidate> = [],
): MobilePairingCandidate[] {
  const candidates: MobilePairingCandidate[] = [];
  const seen = new Set<string>();
  const port = config.port;
  const acceptsLanConnections = serverAcceptsNonLoopback(config);

  addCandidate(candidates, seen, `http://127.0.0.1:${port}`, "Simulator on this Mac");

  const requestHost = url.hostname;
  if (requestHost && !isLoopbackHost(requestHost)) {
    addCandidate(candidates, seen, url.origin.replace(/\/+$/, ""), "Current browser address");
  }

  if (acceptsLanConnections) {
    const localHostname = normalizeLocalHostname(os.hostname());
    if (localHostname) {
      addCandidate(candidates, seen, `http://${localHostname}:${port}`, "Mac local hostname");
    }

    for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.family !== "IPv4" || address.internal) {
          continue;
        }
        addCandidate(candidates, seen, `http://${address.address}:${port}`, name);
      }
    }
  }

  for (const extra of extraCandidates) {
    addCandidate(candidates, seen, extra.apiBaseUrl, extra.label);
  }

  return candidates;
}

const TAILSCALE_CANDIDATES_TTL_MS = 30_000;
const TAILSCALE_CANDIDATES_WAIT_MS = 2_500;

let tailscaleCandidatesCache: {
  readonly expiresAt: number;
  readonly candidates: MobilePairingCandidate[];
} | null = null;
let tailscaleCandidatesRefresh: Promise<MobilePairingCandidate[]> | null = null;

/**
 * Tailscale-reachable addresses for this server. When both devices are on the
 * same tailnet, bundling these into the pairing QR makes a single scan work
 * away from the LAN — no manual server URL or owner credentials:
 * - the active Serve/Funnel URL (tailscaled proxies to loopback, so this works
 *   regardless of the bind host), and
 * - the machine's tailnet IPv4 when the server accepts non-loopback traffic.
 *   An IP literal on purpose: iOS ATS blocks plain-HTTP hostnames but not IP
 *   addresses, and MagicDNS may be disabled on the phone.
 */
async function detectTailscaleCandidates(
  config: ServerConfigShape,
): Promise<MobilePairingCandidate[]> {
  const cli = findTailscaleCli();
  if (!cli) {
    return [];
  }
  const [self, serve] = await Promise.all([detectTailscaleSelf(cli), readServe(cli, config.port)]);
  const candidates: MobilePairingCandidate[] = [];
  if (serve.url) {
    candidates.push({
      apiBaseUrl: serve.url.replace(/\/+$/, ""),
      label: serve.method === "tailscale-funnel" ? "Tailscale Funnel" : "Tailscale Serve",
    });
  }
  if (self.running && self.tailscaleIPv4 && serverAcceptsNonLoopback(config)) {
    candidates.push({
      apiBaseUrl: `http://${self.tailscaleIPv4}:${config.port}`,
      label: "Tailscale IP",
    });
  }
  return candidates;
}

function refreshTailscaleCandidates(config: ServerConfigShape): Promise<MobilePairingCandidate[]> {
  if (!tailscaleCandidatesRefresh) {
    tailscaleCandidatesRefresh = detectTailscaleCandidates(config)
      .catch((): MobilePairingCandidate[] => [])
      .then((candidates) => {
        tailscaleCandidatesCache = {
          expiresAt: Date.now() + TAILSCALE_CANDIDATES_TTL_MS,
          candidates,
        };
        tailscaleCandidatesRefresh = null;
        return candidates;
      });
  }
  return tailscaleCandidatesRefresh;
}

/**
 * Cached tailscale candidates without blocking: the iOS app probes
 * /api/mobile/connection with ~1s timeouts, so device-facing responses must
 * never wait on the tailscale CLI. A stale or missing cache kicks off a
 * background refresh for the next request.
 */
function cachedTailscaleCandidates(config: ServerConfigShape): MobilePairingCandidate[] {
  if (!tailscaleCandidatesCache || Date.now() >= tailscaleCandidatesCache.expiresAt) {
    void refreshTailscaleCandidates(config);
  }
  return tailscaleCandidatesCache?.candidates ?? [];
}

/**
 * Tailscale candidates for QR creation: wait briefly for a fresh detection so
 * a just-generated code includes the tailnet addresses, but stay bounded so
 * the settings panel never hangs on a wedged tailscale CLI.
 */
async function tailscaleCandidatesForPairing(
  config: ServerConfigShape,
): Promise<MobilePairingCandidate[]> {
  if (tailscaleCandidatesCache && Date.now() < tailscaleCandidatesCache.expiresAt) {
    return tailscaleCandidatesCache.candidates;
  }
  const fresh = await Promise.race([
    refreshTailscaleCandidates(config),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), TAILSCALE_CANDIDATES_WAIT_MS)),
  ]);
  return fresh ?? tailscaleCandidatesCache?.candidates ?? [];
}

function pruneExpiredPairingSessions(now = Date.now()) {
  for (const [pairingId, session] of pairingSessions) {
    if (Date.parse(session.expiresAt) <= now) {
      pairingSessions.delete(pairingId);
    }
  }
}

async function createPairingSession(
  config: ServerConfigShape,
  url: URL,
): Promise<MobilePairingSession> {
  pruneExpiredPairingSessions();

  const pairingId = randomUUID();
  const pairingSecret = createSecret(24);
  const expiresAt = new Date(Date.now() + PAIRING_SESSION_TTL_MS).toISOString();
  const candidates = mobilePairingCandidates(
    config,
    url,
    await tailscaleCandidatesForPairing(config),
  );
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
  url: URL,
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
    apiBaseUrls: mobilePairingCandidates(config, url, cachedTailscaleCandidates(config)).map(
      (candidate) => candidate.apiBaseUrl,
    ),
  };
}

const MobileLoginRequest = Schema.Struct({
  username: Schema.String,
  password: Schema.String,
  deviceName: Schema.optional(Schema.String),
});

/**
 * Register a device using owner credentials (instead of a local QR pairing
 * secret). This is the "connect to a remote server" path: the user enters the
 * server URL + username/password, and we mint the same opaque device token the
 * QR pairing flow produces, so the rest of the mobile API is unchanged.
 */
async function loginDevice(
  config: ServerConfigShape,
  url: URL,
  deviceNameInput: string,
): Promise<MobilePairResult> {
  const now = new Date().toISOString();
  const deviceId = randomUUID();
  const token = createSecret();
  const deviceName = normalizeDeviceName(deviceNameInput);
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

  return {
    deviceId,
    token,
    deviceName,
    pairedAt: now,
    apiBaseUrls: mobilePairingCandidates(config, url, cachedTailscaleCandidates(config)).map(
      (candidate) => candidate.apiBaseUrl,
    ),
  };
}

function mobileConnectionInfo(
  config: ServerConfigShape,
  url: URL,
  device: StoredMobileDevice,
): MobileConnectionInfo {
  const candidates = mobilePairingCandidates(config, url, cachedTailscaleCandidates(config));
  return {
    version: 1,
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    pairedAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt,
    apiBaseUrls: candidates.map((candidate) => candidate.apiBaseUrl),
    candidates,
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

/**
 * Collapse a thread's per-turn checkpoint diffs into one entry per file so the
 * phone can show a compact "files changed" card: additions/deletions accumulate
 * across turns and the most recent turn wins the change kind.
 */
function aggregateFileChanges(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
): MobileFileChange[] {
  const byPath = new Map<string, { kind: string; additions: number; deletions: number }>();
  for (const checkpoint of checkpoints) {
    for (const file of checkpoint.files) {
      const existing = byPath.get(file.path);
      if (existing) {
        existing.additions += file.additions;
        existing.deletions += file.deletions;
        existing.kind = file.kind;
      } else {
        byPath.set(file.path, {
          kind: file.kind,
          additions: file.additions,
          deletions: file.deletions,
        });
      }
    }
  }
  return [...byPath.entries()]
    .map(([path, change]) => ({ path, ...change }))
    .toSorted((left, right) => left.path.localeCompare(right.path));
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
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
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
      fileChanges: aggregateFileChanges(thread.checkpoints),
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

    const runtimeMode = command.runtimeMode ?? "full-access";
    const interactionMode = command.interactionMode ?? "default";
    const threadId = ThreadId.makeUnsafe(randomUUID());
    const createResult = yield* startup.enqueueCommand(
      engine.dispatch({
        type: "thread.create",
        commandId,
        threadId,
        projectId: project.id,
        title: normalizePromptText(command.title ?? "") || "New Thread",
        modelSelection,
        runtimeMode,
        interactionMode,
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    const initialMessage = normalizePromptText(command.initialMessage ?? "");
    const initialAttachments = command.attachments ?? [];
    if (!initialMessage && initialAttachments.length === 0) {
      return { sequence: createResult.sequence, threadId } satisfies MobileCommandResult;
    }

    const normalizedTurnCommand = yield* normalizeDispatchCommand({
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe(`${command.requestId}:turn`),
      threadId,
      message: {
        messageId: MessageId.makeUnsafe(randomUUID()),
        role: "user",
        text: initialMessage,
        attachments: initialAttachments,
      },
      modelSelection,
      runtimeMode,
      interactionMode,
      createdAt: now,
    });
    const turnResult = yield* startup.enqueueCommand(engine.dispatch(normalizedTurnCommand));
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
      const attachments = command.attachments ?? [];
      if (!text && attachments.length === 0) {
        return yield* Effect.fail(new Error("Message cannot be empty."));
      }
      const normalizedCommand = yield* normalizeDispatchCommand({
        type: "thread.turn.start",
        commandId,
        threadId: command.threadId,
        message: {
          messageId: MessageId.makeUnsafe(randomUUID()),
          role: "user",
          text,
          attachments,
        },
        modelSelection: command.modelSelection ?? thread.modelSelection,
        runtimeMode: command.runtimeMode ?? thread.runtimeMode,
        interactionMode: command.interactionMode ?? thread.interactionMode,
        createdAt: now,
      });
      const result = yield* startup.enqueueCommand(engine.dispatch(normalizedCommand));
      return {
        sequence: result.sequence,
        threadId: command.threadId,
      } satisfies MobileCommandResult;
    }

    case "thread.turn.steer": {
      const text = normalizePromptText(command.text);
      if (!text) {
        return yield* Effect.fail(new Error("Message cannot be empty."));
      }
      const result = yield* startup.enqueueCommand(
        engine.dispatch({
          type: "thread.turn.steer",
          commandId,
          threadId: command.threadId,
          message: {
            messageId: MessageId.makeUnsafe(randomUUID()),
            role: "user",
            text,
          },
          createdAt: now,
        }),
      );
      return {
        sequence: result.sequence,
        threadId: command.threadId,
      } satisfies MobileCommandResult;
    }

    case "thread.runtime-mode.set": {
      const result = yield* startup.enqueueCommand(
        engine.dispatch({
          type: "thread.runtime-mode.set",
          commandId,
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          createdAt: now,
        }),
      );
      return {
        sequence: result.sequence,
        threadId: command.threadId,
      } satisfies MobileCommandResult;
    }

    case "thread.interaction-mode.set": {
      const result = yield* startup.enqueueCommand(
        engine.dispatch({
          type: "thread.interaction-mode.set",
          commandId,
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          createdAt: now,
        }),
      );
      return {
        sequence: result.sequence,
        threadId: command.threadId,
      } satisfies MobileCommandResult;
    }

    case "thread.meta.update": {
      const result = yield* startup.enqueueCommand(
        engine.dispatch({
          type: "thread.meta.update",
          commandId,
          threadId: command.threadId,
          modelSelection: command.modelSelection,
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
    Effect.flatMap(({ config, url }) =>
      Effect.promise(() => createPairingSession(config, url)).pipe(
        Effect.map((session) => successResponse(session)),
      ),
    ),
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
    const url = requestUrl(request);
    if (!url) {
      return yield* Effect.fail(new Error("Invalid request URL."));
    }
    const config = yield* ServerConfig;
    const input = yield* decodeJson(request, MobilePairRequest, "Invalid mobile pairing request.");
    const result = yield* Effect.promise(() => pairDevice(config, url, input));
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

const mobileLoginRouteLayer = HttpRouter.add(
  "POST",
  "/api/mobile/login",
  Effect.gen(function* () {
    yield* requireMobileEnabled;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = requestUrl(request);
    if (!url) {
      return yield* Effect.fail(new Error("Invalid request URL."));
    }
    const config = yield* ServerConfig;
    const auth = yield* EnvironmentAuth;
    if (!auth.authConfigured) {
      return errorResponse("No credentials are configured on this server.", 503);
    }
    const input = yield* decodeJson(request, MobileLoginRequest, "Invalid login request.");
    if (!auth.verifyCredentials({ username: input.username, password: input.password })) {
      return errorResponse("Invalid username or password.", 401);
    }
    const result = yield* Effect.promise(() =>
      loginDevice(config, url, input.deviceName ?? "iPhone"),
    );
    return successResponse(result);
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        error instanceof Error
          ? errorResponse(error.message, routeErrorStatus(error, 400))
          : errorResponse("Login failed.", 400),
      ),
    ),
  ),
);

const mobileConnectionRouteLayer = HttpRouter.add(
  "GET",
  "/api/mobile/connection",
  requireMobileAuth.pipe(
    Effect.map(({ config, url, device }) =>
      successResponse(mobileConnectionInfo(config, url, device)),
    ),
    Effect.catch((error) =>
      Effect.succeed(errorResponse(error.message, routeErrorStatus(error, 401))),
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

const mobileWorkspaceEntriesRouteLayer = HttpRouter.add(
  "GET",
  "/api/mobile/workspace/entries",
  requireMobileAuth.pipe(
    Effect.flatMap(({ url }) =>
      Effect.gen(function* () {
        const projectIdRaw = url.searchParams.get("projectId");
        if (!projectIdRaw) {
          return errorResponse("Missing projectId.", 400);
        }
        const query = (url.searchParams.get("query") ?? "").trim();
        const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "25", 10);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 25;

        const engine = yield* OrchestrationEngineService;
        const readModel = yield* engine.getReadModel();
        const project = resolveProject(readModel, ProjectId.makeUnsafe(projectIdRaw));
        if (!project) {
          return errorResponse("Project not found.", 404);
        }

        const workspaceEntries = yield* WorkspaceEntries;
        if (!query) {
          const listing = yield* workspaceEntries.listDirectory({
            cwd: project.workspaceRoot,
          });
          return successResponse({
            entries: listing.entries.slice(0, limit),
            truncated: listing.truncated || listing.entries.length > limit,
          });
        }

        const input = yield* Effect.try({
          try: () =>
            Schema.decodeUnknownSync(ProjectSearchEntriesInput)({
              cwd: project.workspaceRoot,
              query,
              limit,
            }),
          catch: (cause) => mobileRouteError("Invalid workspace search query.", cause),
        });
        const result = yield* workspaceEntries.search(input);
        return successResponse({ entries: result.entries, truncated: result.truncated });
      }),
    ),
    Effect.catch((error) =>
      Effect.succeed(
        error instanceof Error
          ? errorResponse(error.message, routeErrorStatus(error, 400))
          : errorResponse("Workspace search failed.", 400),
      ),
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
  mobileLoginRouteLayer,
  mobileConnectionRouteLayer,
  mobileSnapshotRouteLayer,
  mobileEventsRouteLayer,
  mobileWorkspaceEntriesRouteLayer,
  mobileCommandRouteLayer,
);
