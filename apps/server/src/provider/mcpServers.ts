import { createHash, randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { copyFile, cp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  auth,
  createMCPClient,
  UnauthorizedError,
  type MCPClient,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type * as EffectAcpSchema from "effect-acp/schema";
import open from "open";
import {
  parse as parseToml,
  stringify as stringifyToml,
  type TomlTable,
  type TomlValue,
} from "smol-toml";
import type {
  EffectiveMcpServerAuth,
  EffectiveMcpServerAuthInput,
  EffectiveMcpServerEntry,
  EffectiveMcpServerRemoveInput,
  McpServerEntry,
  ProviderKind,
  ServerSettings,
  ThreadId,
} from "contracts";
import type { ServerConfigShape } from "../config";

export interface ProviderMcpDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ProviderMcpToolExecutor {
  readonly title: string;
  readonly execute: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface ProviderMcpToolRuntime {
  readonly descriptors: ReadonlyArray<ProviderMcpDescriptor>;
  readonly executors: ReadonlyMap<string, ProviderMcpToolExecutor>;
  readonly warnings: ReadonlyArray<string>;
  readonly close: () => Promise<void>;
}

export interface BuildProviderMcpToolRuntimeOptions {
  readonly createClient?: (input: {
    readonly entry: McpServerEntry;
    readonly cwd?: string;
  }) => Promise<MCPClient>;
  readonly oauthStorageDir?: string;
  readonly oauthCallbackTimeoutMs?: number;
  readonly openAuthorizationUrl?: (url: URL) => Promise<void>;
  readonly allowInteractiveOAuth?: boolean;
  readonly connectTimeoutMs?: number;
  readonly listToolsTimeoutMs?: number;
}

export interface EffectiveMcpServersResult {
  readonly servers: ReadonlyArray<McpServerEntry>;
  readonly warnings: ReadonlyArray<string>;
}

export interface EffectiveMcpServerRowsResult {
  readonly servers: ReadonlyArray<EffectiveMcpServerEntry>;
  readonly warnings: ReadonlyArray<string>;
}

interface DiscoveredMcpServerEntry extends McpServerEntry {
  readonly source: "codex" | "claude";
  readonly sourceName: string;
  readonly configPath: string;
}

const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MCP_LIST_TOOLS_TIMEOUT_MS = 10_000;
const DEFAULT_MCP_OAUTH_CALLBACK_TIMEOUT_MS = 120_000;
const MCP_OAUTH_PORT_BASE = 38_200;
const MCP_OAUTH_PORT_SPAN = 1_000;
const activeInteractiveMcpAuthentications = new Map<string, Promise<void>>();

interface McpOAuthStorage {
  readonly redirectUrl?: string;
  readonly tokens?: OAuthTokens;
  readonly clientInformation?: OAuthClientInformation;
  readonly codeVerifier?: string;
  readonly state?: string;
}

interface McpOAuthStoragePatch {
  readonly redirectUrl?: string | undefined;
  readonly tokens?: OAuthTokens | undefined;
  readonly clientInformation?: OAuthClientInformation | undefined;
  readonly codeVerifier?: string | undefined;
  readonly state?: string | undefined;
}

class InteractiveMcpAuthRequiredError extends Error {
  constructor(serverName: string) {
    super(
      `Authentication required for MCP server '${serverName}'. Open Settings > Skills & MCP and click Authenticate.`,
    );
    this.name = "InteractiveMcpAuthRequiredError";
  }
}

interface LocalCallbackServer {
  readonly url: string;
  readonly close: () => Promise<void>;
  readonly waitForCallback: (timeoutMs: number) => Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length > 0 ? strings : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).flatMap(([key, entry]) =>
    typeof entry === "string" ? [[key, entry] as const] : [],
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function sourceServerName(source: "codex" | "claude", name: string): string {
  return `${source}:${name}`;
}

function normalizeTransport(value: unknown, hasUrl: boolean): "stdio" | "sse" | "http" {
  const normalized = asString(value)?.toLowerCase().replace(/-/g, "_");
  if (normalized === "sse") {
    return "sse";
  }
  if (
    normalized === "http" ||
    normalized === "streamable_http" ||
    normalized === "streamablehttp"
  ) {
    return "http";
  }
  return hasUrl ? "http" : "stdio";
}

function mcpServerEntryFromRaw(input: {
  readonly source: "codex" | "claude";
  readonly name: string;
  readonly configPath: string;
  readonly raw: unknown;
}): DiscoveredMcpServerEntry | null {
  if (!isRecord(input.raw)) {
    return null;
  }

  const url = asString(input.raw.url);
  const command = asString(input.raw.command);
  const transport = normalizeTransport(input.raw.transport ?? input.raw.type, url !== undefined);
  const headers = asStringRecord(input.raw.http_headers ?? input.raw.headers);
  const args = asStringArray(input.raw.args);
  const env = asStringRecord(input.raw.env);
  const enabled = asBoolean(input.raw.enabled, true);

  if (transport === "stdio" && !command) {
    return null;
  }
  if (transport !== "stdio" && !url) {
    return null;
  }

  return {
    name: sourceServerName(input.source, input.name),
    sourceName: input.name,
    configPath: input.configPath,
    source: input.source,
    transport,
    enabled,
    providers: ["shiori"],
    ...(url ? { url } : {}),
    ...(headers ? { headers } : {}),
    ...(command ? { command } : {}),
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
  };
}

function mcpEntriesFromServerMap(input: {
  readonly source: "codex" | "claude";
  readonly configPath: string;
  readonly servers: unknown;
}): DiscoveredMcpServerEntry[] {
  if (!isRecord(input.servers)) {
    return [];
  }
  return Object.entries(input.servers).flatMap(([name, raw]) => {
    const entry = mcpServerEntryFromRaw({
      source: input.source,
      name,
      configPath: input.configPath,
      raw,
    });
    return entry ? [entry] : [];
  });
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const raw = await readFile(filePath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return null;
  }
  return JSON.parse(raw) as unknown;
}

async function readClaudeMcpServersFile(filePath: string): Promise<McpServerEntry[]> {
  const parsed = await readJsonFile(filePath);
  const serverMap = isRecord(parsed) ? (parsed.mcpServers ?? parsed.mcp_servers) : undefined;
  return mcpEntriesFromServerMap({ source: "claude", configPath: filePath, servers: serverMap });
}

function readTomlTable(value: TomlValue | undefined): TomlTable | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as TomlTable)
    : undefined;
}

async function readCodexMcpServersFile(filePath: string): Promise<McpServerEntry[]> {
  const raw = await readFile(filePath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return [];
  }
  const parsed = parseToml(raw);
  const serverMap = readTomlTable(parsed.mcp_servers ?? parsed.mcpServers);
  return mcpEntriesFromServerMap({ source: "codex", configPath: filePath, servers: serverMap });
}

function uniqueExistingFilePaths(paths: ReadonlyArray<string | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of paths) {
    if (!candidate) {
      continue;
    }
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function parentDirs(startPath: string | undefined): string[] {
  if (!startPath) {
    return [];
  }
  const dirs: string[] = [];
  let current = path.resolve(startPath);
  while (true) {
    dirs.push(current);
    const next = path.dirname(current);
    if (next === current) {
      break;
    }
    current = next;
  }
  return dirs.toReversed();
}

async function readMcpServersFromFiles(
  filePaths: ReadonlyArray<string>,
  reader: (filePath: string) => Promise<McpServerEntry[]>,
): Promise<EffectiveMcpServersResult> {
  const entries: McpServerEntry[] = [];
  const warnings: string[] = [];
  for (const filePath of filePaths) {
    try {
      entries.push(...(await reader(filePath)));
    } catch (error) {
      warnings.push(
        `Failed to load MCP servers from ${filePath}: ${normalizeErrorMessage(
          error,
          "unknown error",
        )}`,
      );
    }
  }
  return { servers: entries, warnings };
}

export async function discoverCodexMcpServers(input: {
  readonly cwd?: string;
  readonly homePath?: string;
}): Promise<EffectiveMcpServersResult> {
  const codexHome = resolveCodexHomePath(input.homePath);
  const filePaths = uniqueExistingFilePaths([
    path.join(codexHome, "config.toml"),
    ...parentDirs(input.cwd).map((dir) => path.join(dir, ".codex", "config.toml")),
  ]);
  return await readMcpServersFromFiles(filePaths, readCodexMcpServersFile);
}

function claudeDesktopConfigPath(): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }
  return path.join(
    homedir(),
    "Library",
    "Application Support",
    "Claude",
    "claude_desktop_config.json",
  );
}

export async function discoverClaudeMcpServers(input: {
  readonly cwd?: string;
  readonly homePath?: string;
  readonly desktopConfigPath?: string;
}): Promise<EffectiveMcpServersResult> {
  const claudeHome = input.homePath ?? path.join(homedir(), ".claude");
  const filePaths = uniqueExistingFilePaths([
    path.join(claudeHome, "settings.json"),
    input.desktopConfigPath ?? claudeDesktopConfigPath(),
    ...parentDirs(input.cwd).flatMap((dir) => [
      path.join(dir, ".claude", "settings.json"),
      path.join(dir, ".claude", "settings.local.json"),
      path.join(dir, ".mcp.json"),
    ]),
  ]);
  return await readMcpServersFromFiles(filePaths, readClaudeMcpServersFile);
}

function mergeMcpServers(servers: ReadonlyArray<McpServerEntry>): McpServerEntry[] {
  const byName = new Map<string, McpServerEntry>();
  for (const server of servers) {
    byName.set(server.name, server);
  }
  return [...byName.values()];
}

function sortStringRecord(
  value: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!value) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function equivalentMcpServerSignature(server: McpServerEntry): string {
  return JSON.stringify({
    transport: server.transport,
    ...(server.url ? { url: server.url } : {}),
    ...(server.command ? { command: server.command } : {}),
    ...(server.args ? { args: [...server.args] } : {}),
    ...(server.env ? { env: sortStringRecord(server.env) } : {}),
    ...(server.headers ? { headers: sortStringRecord(server.headers) } : {}),
  });
}

function dedupeEquivalentMcpServers(servers: ReadonlyArray<McpServerEntry>): McpServerEntry[] {
  const deduped: McpServerEntry[] = [];
  const seen = new Set<string>();

  for (const server of servers) {
    const signature = equivalentMcpServerSignature(server);
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    deduped.push(server);
  }

  return deduped;
}

export async function loadEffectiveMcpServersForProvider(input: {
  readonly provider: ProviderKind;
  readonly settings: ServerSettings;
  readonly cwd?: string;
}): Promise<EffectiveMcpServersResult> {
  if (input.provider !== "shiori") {
    return {
      servers: filterMcpServersForProvider(input.provider, input.settings.mcpServers.servers),
      warnings: [],
    };
  }

  const [codex, claude] = await Promise.all([
    discoverCodexMcpServers({
      ...(input.cwd ? { cwd: input.cwd } : {}),
      homePath: input.settings.providers.codex.homePath,
    }),
    input.cwd ? discoverClaudeMcpServers({ cwd: input.cwd }) : discoverClaudeMcpServers({}),
  ]);

  const servers = mergeMcpServers([
    ...input.settings.mcpServers.servers,
    ...codex.servers,
    ...claude.servers,
  ]);
  return {
    servers: dedupeEquivalentMcpServers(filterMcpServersForProvider(input.provider, servers)),
    warnings: [...codex.warnings, ...claude.warnings],
  };
}

function retargetMcpServerForProvider(
  server: McpServerEntry,
  provider: ProviderKind,
): McpServerEntry {
  return {
    ...server,
    providers: [provider],
  };
}

function discoveredConfigPath(server: McpServerEntry): string | undefined {
  const maybeDiscovered = server as Partial<DiscoveredMcpServerEntry>;
  return maybeDiscovered.configPath;
}

export async function loadCodexManagedMcpServers(input: {
  readonly settings: ServerSettings;
  readonly cwd?: string;
  readonly claudeHomePath?: string;
  readonly claudeDesktopConfigPath?: string;
}): Promise<EffectiveMcpServersResult> {
  const sourceHome = resolveCodexHomePath(input.settings.providers.codex.homePath);
  const globalCodexConfigPath = path.resolve(sourceHome, "config.toml");
  const [codex, claude] = await Promise.all([
    discoverCodexMcpServers({
      ...(input.cwd ? { cwd: input.cwd } : {}),
      homePath: input.settings.providers.codex.homePath,
    }),
    discoverClaudeMcpServers({
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.claudeHomePath ? { homePath: input.claudeHomePath } : {}),
      ...(input.claudeDesktopConfigPath
        ? { desktopConfigPath: input.claudeDesktopConfigPath }
        : {}),
    }),
  ]);

  const projectCodexServers = codex.servers.filter(
    (server) => path.resolve(discoveredConfigPath(server) ?? "") !== globalCodexConfigPath,
  );
  const servers = mergeMcpServers([
    ...input.settings.mcpServers.servers,
    ...projectCodexServers.map((server) => retargetMcpServerForProvider(server, "codex")),
    ...claude.servers.map((server) => retargetMcpServerForProvider(server, "codex")),
  ]);

  return {
    servers: filterMcpServersForProvider("codex", servers),
    warnings: [...codex.warnings, ...claude.warnings],
  };
}

function resolveEffectiveServerMetadata(
  server: McpServerEntry,
): Pick<EffectiveMcpServerEntry, "source" | "sourceName" | "configPath" | "readOnly"> {
  if (server.name.startsWith("codex:")) {
    const discovered = server as Partial<DiscoveredMcpServerEntry>;
    return {
      source: "codex",
      ...(discovered.sourceName ? { sourceName: discovered.sourceName } : {}),
      ...(discovered.configPath ? { configPath: discovered.configPath } : {}),
      readOnly: true,
    };
  }
  if (server.name.startsWith("claude:")) {
    const discovered = server as Partial<DiscoveredMcpServerEntry>;
    return {
      source: "claude",
      ...(discovered.sourceName ? { sourceName: discovered.sourceName } : {}),
      ...(discovered.configPath ? { configPath: discovered.configPath } : {}),
      readOnly: true,
    };
  }
  return { source: "shiori", readOnly: false };
}

async function resolveEffectiveMcpServerAuth(input: {
  readonly server: McpServerEntry;
  readonly source: EffectiveMcpServerEntry["source"];
  readonly oauthStorageDir?: string;
}): Promise<EffectiveMcpServerAuth> {
  if (input.source !== "shiori") {
    return { status: "unknown" };
  }
  if (input.server.transport === "stdio") {
    return { status: "unknown" };
  }
  if ((input.server.headers ? Object.keys(input.server.headers).length : 0) > 0) {
    return { status: "unknown" };
  }
  const serverUrl = input.server.url?.trim();
  if (!input.oauthStorageDir || !serverUrl) {
    return { status: "unknown" };
  }

  const storage = await readOAuthStorage(
    mcpOAuthStorageFile({
      storageDir: input.oauthStorageDir,
      serverName: input.server.name,
      serverUrl,
    }),
  );

  return storage.tokens?.access_token
    ? { status: "authenticated", message: "Authenticated" }
    : { status: "unauthenticated", message: "Authentication required" };
}

export async function listEffectiveMcpServerRows(input: {
  readonly settings: ServerSettings;
  readonly cwd?: string;
  readonly oauthStorageDir?: string;
}): Promise<EffectiveMcpServerRowsResult> {
  const effective = await loadEffectiveMcpServersForProvider({
    provider: "shiori",
    settings: input.settings,
    ...(input.cwd ? { cwd: input.cwd } : {}),
  });
  return {
    servers: await Promise.all(
      effective.servers.map(async (server): Promise<EffectiveMcpServerEntry> => {
        const metadata = resolveEffectiveServerMetadata(server);
        return {
          ...server,
          ...metadata,
          auth: await resolveEffectiveMcpServerAuth({
            server,
            source: metadata.source,
            ...(input.oauthStorageDir ? { oauthStorageDir: input.oauthStorageDir } : {}),
          }),
        };
      }),
    ),
    warnings: effective.warnings,
  };
}

function matchesEffectiveMcpServerTarget(
  server: EffectiveMcpServerEntry,
  target: EffectiveMcpServerAuthInput,
): boolean {
  if (server.source !== target.source || server.name !== target.name) {
    return false;
  }
  if (target.sourceName !== undefined && server.sourceName !== target.sourceName) {
    return false;
  }
  if (target.configPath !== undefined && server.configPath !== target.configPath) {
    return false;
  }
  return true;
}

function interactiveMcpAuthKey(
  entry: Pick<McpServerEntry, "name" | "url">,
  storageDir: string,
): string {
  return mcpOAuthStorageFile({
    storageDir,
    serverName: entry.name,
    serverUrl: entry.url?.trim() ?? "",
  });
}

export async function authenticateEffectiveMcpServer(input: {
  readonly settings: ServerSettings;
  readonly target: EffectiveMcpServerAuthInput;
  readonly oauthStorageDir: string;
  readonly cwd?: string;
  readonly oauthCallbackTimeoutMs?: number;
  readonly openAuthorizationUrl?: (url: URL) => Promise<void>;
}): Promise<void> {
  const effective = await listEffectiveMcpServerRows({
    settings: input.settings,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    oauthStorageDir: input.oauthStorageDir,
  });
  const server = effective.servers.find((entry) =>
    matchesEffectiveMcpServerTarget(entry, input.target),
  );
  if (!server) {
    throw new Error(`MCP server '${input.target.name}' is no longer configured.`);
  }
  if (server.source !== "shiori") {
    throw new Error("Only Shiori-managed MCP servers can be authenticated from this screen.");
  }
  if (server.transport === "stdio") {
    throw new Error("Only remote MCP servers support browser authentication.");
  }
  if ((server.headers ? Object.keys(server.headers).length : 0) > 0) {
    throw new Error("This MCP server uses static headers and cannot be authenticated here.");
  }
  const serverUrl = server.url?.trim();
  if (!serverUrl) {
    throw new Error(`MCP server '${server.name}' is missing a URL.`);
  }

  const authKey = interactiveMcpAuthKey(server, input.oauthStorageDir);
  const inFlight = activeInteractiveMcpAuthentications.get(authKey);
  if (inFlight) {
    await inFlight;
    return;
  }

  const runAuthentication = (async () => {
    const oauthProvider = await createMcpOAuthProvider({
      serverName: server.name,
      serverUrl,
      storageDir: input.oauthStorageDir,
      callbackTimeoutMs: input.oauthCallbackTimeoutMs ?? DEFAULT_MCP_OAUTH_CALLBACK_TIMEOUT_MS,
      openAuthorizationUrl:
        input.openAuthorizationUrl ??
        (async (authorizationUrl) => {
          await open(authorizationUrl.href);
        }),
      allowInteractiveAuthorization: true,
    });

    try {
      await auth(oauthProvider, { serverUrl });
    } finally {
      await oauthProvider.close();
    }
  })().finally(() => {
    activeInteractiveMcpAuthentications.delete(authKey);
  });

  activeInteractiveMcpAuthentications.set(authKey, runAuthentication);
  await runAuthentication;
}

function tomlPathSegments(rawPath: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < rawPath.length; index += 1) {
    const char = rawPath[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ".") {
      segments.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) {
    segments.push(current.trim());
  }
  return segments;
}

function removeCodexMcpServerFromToml(raw: string, sourceName: string): string {
  const lines = raw.split(/\r?\n/g);
  const nextLines: string[] = [];
  let skipping = false;
  let removed = false;

  for (const line of lines) {
    const tableMatch = line.trim().match(/^\[([^\]]+)\]\s*(?:#.*)?$/);
    if (tableMatch?.[1]) {
      const segments = tomlPathSegments(tableMatch[1]);
      skipping = segments[0] === "mcp_servers" && segments[1] === sourceName;
      if (skipping) {
        removed = true;
        continue;
      }
    }

    if (!skipping) {
      nextLines.push(line);
    }
  }

  if (!removed) {
    throw new Error(`MCP server '${sourceName}' was not found in Codex config.`);
  }

  return nextLines.join("\n").replace(/\n{3,}/g, "\n\n");
}

async function removeClaudeMcpServerFromJson(filePath: string, sourceName: string): Promise<void> {
  const parsed = await readJsonFile(filePath);
  if (!isRecord(parsed)) {
    throw new Error(`Claude MCP config at ${filePath} is not a JSON object.`);
  }
  let removed = false;
  for (const key of ["mcpServers", "mcp_servers"] as const) {
    const servers = parsed[key];
    if (isRecord(servers) && sourceName in servers) {
      delete servers[sourceName];
      removed = true;
    }
  }
  if (!removed) {
    throw new Error(`MCP server '${sourceName}' was not found in Claude config.`);
  }
  await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

export async function removeExternalMcpServer(input: EffectiveMcpServerRemoveInput): Promise<void> {
  const sourceName = input.sourceName ?? input.name.replace(/^(codex|claude):/, "");
  const configPath = input.configPath;
  if (!configPath) {
    throw new Error(`Cannot remove '${input.name}' because its config path is unknown.`);
  }

  if (input.source === "codex") {
    const raw = await readFile(configPath, "utf8");
    await writeFile(configPath, removeCodexMcpServerFromToml(raw, sourceName), "utf8");
    return;
  }
  if (input.source === "claude") {
    await removeClaudeMcpServerFromJson(configPath, sourceName);
    return;
  }

  throw new Error("Shiori MCP servers are removed through ShioriCode settings.");
}

export function filterMcpServersForProvider(
  provider: ProviderKind,
  servers: ReadonlyArray<McpServerEntry>,
): ReadonlyArray<McpServerEntry> {
  return servers.filter((server) => {
    if (!server.enabled) return false;
    return server.providers.length === 0 || server.providers.includes(provider);
  });
}

export function toAcpMcpServers(
  provider: ProviderKind,
  settings: ServerSettings,
  cwd?: string,
  options?: {
    readonly browserPanel?: {
      readonly config: ServerConfigShape;
      readonly threadId: ThreadId;
    };
  },
): ReadonlyArray<EffectAcpSchema.McpServer> {
  const acpServers: EffectAcpSchema.McpServer[] = [];
  for (const server of filterMcpServersForProvider(provider, settings.mcpServers.servers)) {
    switch (server.transport) {
      case "stdio": {
        const command = server.command?.trim();
        if (!command) break;
        acpServers.push({
          name: server.name,
          command,
          args: server.args ?? [],
          env: Object.entries(server.env ?? {}).map(([name, value]) => ({
            name,
            value,
          })),
          ...(cwd ? { _meta: { cwd } } : {}),
        });
        break;
      }
      case "http": {
        const url = server.url?.trim();
        if (!url) break;
        acpServers.push({
          type: "http",
          name: server.name,
          url,
          headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({
            name,
            value,
          })),
        });
        break;
      }
      case "sse": {
        const url = server.url?.trim();
        if (!url) break;
        acpServers.push({
          type: "sse",
          name: server.name,
          url,
          headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({
            name,
            value,
          })),
        });
        break;
      }
    }
  }
  if (settings.browserUse.enabled && options?.browserPanel) {
    acpServers.push(
      makeBuiltInStdioMcpServer("shioricode-browser", "browser-panel-mcp", {
        SHIORICODE_BROWSER_CONTROL_URL: browserPanelControlUrl(options.browserPanel.config),
        SHIORICODE_BROWSER_THREAD_ID: options.browserPanel.threadId,
        ...(options.browserPanel.config.authToken
          ? { SHIORICODE_BROWSER_CONTROL_TOKEN: options.browserPanel.config.authToken }
          : {}),
      }),
    );
  }
  if (settings.computerUse.enabled) {
    acpServers.push(makeBuiltInStdioMcpServer("shioricode-computer", "computer-use-mcp"));
  }
  return acpServers;
}

function makeBuiltInStdioMcpServer(
  name: string,
  subcommand: string,
  env?: Record<string, string>,
): EffectAcpSchema.McpServer {
  return {
    name,
    command: process.execPath,
    args: [...serverEntrypointArgs(), subcommand],
    env: Object.entries(env ?? {}).map(([envName, value]) => ({
      name: envName,
      value,
    })),
  };
}

function serverEntrypointArgs(): ReadonlyArray<string> {
  return process.argv[1] ? [process.argv[1]] : [];
}

function browserPanelControlUrl(config: ServerConfigShape): string {
  const configHost = config.host ?? "127.0.0.1";
  const host =
    configHost === "0.0.0.0" || configHost === "::" || configHost === "" ? "127.0.0.1" : configHost;
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}:${config.port}/api/browser-panel/command`;
}

function sanitizeIdentifier(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : fallback;
}

function prefixedShioriToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeIdentifier(serverName, "server")}__${sanitizeIdentifier(toolName, "tool")}`;
}

function resolveMcpToolDescription(tool: {
  readonly description?: string | undefined;
  readonly title?: string | undefined;
  readonly name: string;
}): string {
  if (typeof tool.description === "string" && tool.description.trim().length > 0) {
    return tool.description;
  }
  if (typeof tool.title === "string" && tool.title.trim().length > 0) {
    return tool.title;
  }
  return tool.name;
}

function mcpOAuthStorageFile(input: { storageDir: string; serverName: string; serverUrl: string }) {
  const digest = createHash("sha256")
    .update(`${input.serverName}\n${input.serverUrl}`)
    .digest("hex")
    .slice(0, 16);
  return path.join(
    input.storageDir,
    `${sanitizeIdentifier(input.serverName, "server")}-${digest}.json`,
  );
}

async function readOAuthStorage(filePath: string): Promise<McpOAuthStorage> {
  const raw = await readFile(filePath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? (parsed as McpOAuthStorage) : {};
  } catch {
    return {};
  }
}

async function writeOAuthStorage(filePath: string, storage: McpOAuthStorage): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(storage, null, 2)}\n`, "utf8");
}

function oauthBasePort(serverName: string, serverUrl: string): number {
  const digest = createHash("sha256").update(`${serverName}\n${serverUrl}`).digest();
  return MCP_OAUTH_PORT_BASE + (digest.readUInt16BE(0) % MCP_OAUTH_PORT_SPAN);
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function createLocalCallbackServer(input: {
  readonly serverName: string;
  readonly serverUrl: string;
}): Promise<LocalCallbackServer> {
  let resolveCallback: ((url: string) => void) | undefined;
  let rejectCallback: ((error: Error) => void) | undefined;
  let callbackPromise: Promise<string> | undefined;

  const server = http.createServer((request: IncomingMessage, response: ServerResponse) => {
    const host = request.headers.host ?? "127.0.0.1";
    const requestUrl = new URL(request.url ?? "/", `http://${host}`);
    if (requestUrl.pathname !== "/oauth/callback") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><title>ShioriCode MCP authentication</title><p>Authentication complete. You can return to ShioriCode.</p>",
    );
    resolveCallback?.(requestUrl.href);
  });

  const basePort = oauthBasePort(input.serverName, input.serverUrl);
  let listeningPort: number | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const port =
      MCP_OAUTH_PORT_BASE + ((basePort - MCP_OAUTH_PORT_BASE + attempt) % MCP_OAUTH_PORT_SPAN);
    try {
      listeningPort = await listen(server, port);
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (listeningPort === undefined) {
    throw new Error(
      `Unable to start MCP OAuth callback server: ${normalizeErrorMessage(
        lastError,
        "no callback port available",
      )}`,
    );
  }

  return {
    url: `http://127.0.0.1:${listeningPort}/oauth/callback`,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
    waitForCallback: async (timeoutMs: number) => {
      callbackPromise = new Promise<string>((resolve, reject) => {
        resolveCallback = resolve;
        rejectCallback = reject;
      });
      const timer = setTimeout(() => {
        rejectCallback?.(new Error("Timed out waiting for MCP OAuth callback."));
      }, timeoutMs);
      try {
        return await callbackPromise;
      } finally {
        clearTimeout(timer);
        resolveCallback = undefined;
        rejectCallback = undefined;
        callbackPromise = undefined;
      }
    },
  };
}

class FileBackedMcpOAuthProvider implements OAuthClientProvider {
  private storage: McpOAuthStorage;

  constructor(
    private readonly input: {
      readonly serverName: string;
      readonly serverUrl: string;
      readonly callbackServer: LocalCallbackServer;
      readonly storageFile: string;
      readonly callbackTimeoutMs: number;
      readonly openAuthorizationUrl: (url: URL) => Promise<void>;
      readonly allowInteractiveAuthorization: boolean;
    },
    storage: McpOAuthStorage,
  ) {
    this.storage =
      storage.redirectUrl === undefined || storage.redirectUrl === input.callbackServer.url
        ? storage
        : storage.tokens
          ? { tokens: storage.tokens }
          : {};
  }

  private inMemoryCodeVerifier: string | undefined;
  private inMemoryState: string | undefined;

  get redirectUrl(): string {
    return this.input.callbackServer.url;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "ShioriCode",
      client_uri: "https://shiori.ai",
    };
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.storage.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.updateStorage({ tokens });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.input.allowInteractiveAuthorization) {
      await this.updateStorage({
        tokens: undefined,
        codeVerifier: undefined,
        state: undefined,
      });
      throw new InteractiveMcpAuthRequiredError(this.input.serverName);
    }
    await this.input.openAuthorizationUrl(authorizationUrl);
    const callbackUrl = await this.input.callbackServer.waitForCallback(
      this.input.callbackTimeoutMs,
    );
    const parsed = new URL(callbackUrl);
    const error = parsed.searchParams.get("error");
    if (error) {
      throw new Error(`MCP OAuth authorization failed: ${error}`);
    }
    const authorizationCode = parsed.searchParams.get("code");
    if (!authorizationCode) {
      throw new Error("MCP OAuth callback was missing an authorization code.");
    }
    const callbackState = parsed.searchParams.get("state") ?? undefined;
    await auth(this, {
      serverUrl: this.input.serverUrl,
      authorizationCode,
      ...(callbackState ? { callbackState } : {}),
    });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    if (!this.input.allowInteractiveAuthorization) {
      this.inMemoryCodeVerifier = codeVerifier;
      return;
    }
    await this.updateStorage({ codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const codeVerifier = this.inMemoryCodeVerifier ?? this.storage.codeVerifier;
    if (!codeVerifier) {
      throw new Error("MCP OAuth code verifier is missing.");
    }
    return codeVerifier;
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    return this.storage.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformation): Promise<void> {
    await this.updateStorage({ clientInformation });
  }

  async state(): Promise<string> {
    return randomUUID();
  }

  async saveState(state: string): Promise<void> {
    if (!this.input.allowInteractiveAuthorization) {
      this.inMemoryState = state;
      return;
    }
    await this.updateStorage({ state });
  }

  async storedState(): Promise<string | undefined> {
    return this.inMemoryState ?? this.storage.state;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): Promise<void> {
    if (scope === "all") {
      this.inMemoryCodeVerifier = undefined;
      this.inMemoryState = undefined;
      await this.updateStorage({
        tokens: undefined,
        clientInformation: undefined,
        codeVerifier: undefined,
        state: undefined,
      });
      return;
    }
    if (scope === "client") {
      await this.updateStorage({ clientInformation: undefined });
      return;
    }
    if (scope === "tokens") {
      await this.updateStorage({ tokens: undefined });
      return;
    }
    this.inMemoryCodeVerifier = undefined;
    this.inMemoryState = undefined;
    await this.updateStorage({ codeVerifier: undefined, state: undefined });
  }

  async close(): Promise<void> {
    await this.input.callbackServer.close();
  }

  private async updateStorage(patch: McpOAuthStoragePatch): Promise<void> {
    const next: McpOAuthStoragePatch = {
      ...this.storage,
      redirectUrl: this.redirectUrl,
      ...patch,
    };
    for (const key of ["tokens", "clientInformation", "codeVerifier", "state"] as const) {
      if (key in patch && patch[key] === undefined) {
        delete next[key];
      }
    }
    this.storage = next as McpOAuthStorage;
    await writeOAuthStorage(this.input.storageFile, this.storage);
  }
}

async function createMcpOAuthProvider(input: {
  readonly serverName: string;
  readonly serverUrl: string;
  readonly storageDir: string;
  readonly callbackTimeoutMs: number;
  readonly openAuthorizationUrl: (url: URL) => Promise<void>;
  readonly allowInteractiveAuthorization: boolean;
}): Promise<FileBackedMcpOAuthProvider> {
  const callbackServer = await createLocalCallbackServer({
    serverName: input.serverName,
    serverUrl: input.serverUrl,
  });
  const storageFile = mcpOAuthStorageFile({
    storageDir: input.storageDir,
    serverName: input.serverName,
    serverUrl: input.serverUrl,
  });
  const storage = await readOAuthStorage(storageFile);
  return new FileBackedMcpOAuthProvider(
    {
      serverName: input.serverName,
      serverUrl: input.serverUrl,
      callbackServer,
      storageFile,
      callbackTimeoutMs: input.callbackTimeoutMs,
      openAuthorizationUrl: input.openAuthorizationUrl,
      allowInteractiveAuthorization: input.allowInteractiveAuthorization,
    },
    storage,
  );
}

function attachClientClose(client: MCPClient, cleanup: () => Promise<void>): MCPClient {
  const closeClient = client.close.bind(client);
  client.close = async () => {
    await Promise.allSettled([closeClient(), cleanup()]);
  };
  return client;
}

async function createMcpClientForEntry(input: {
  readonly entry: McpServerEntry;
  readonly cwd?: string;
  readonly oauthStorageDir?: string;
  readonly oauthCallbackTimeoutMs?: number;
  readonly openAuthorizationUrl?: (url: URL) => Promise<void>;
  readonly allowInteractiveAuthorization?: boolean;
}): Promise<MCPClient> {
  switch (input.entry.transport) {
    case "stdio": {
      const command = input.entry.command?.trim();
      if (!command) {
        throw new Error(`MCP server '${input.entry.name}' is missing a command.`);
      }
      return await createMCPClient({
        transport: new Experimental_StdioMCPTransport({
          command,
          ...(input.entry.args ? { args: [...input.entry.args] } : {}),
          ...(input.entry.env ? { env: { ...input.entry.env } } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
        }),
      });
    }
    case "http":
    case "sse": {
      const url = input.entry.url?.trim();
      if (!url) {
        throw new Error(`MCP server '${input.entry.name}' is missing a URL.`);
      }
      const oauthProvider = input.oauthStorageDir
        ? await createMcpOAuthProvider({
            serverName: input.entry.name,
            serverUrl: url,
            storageDir: input.oauthStorageDir,
            callbackTimeoutMs:
              input.oauthCallbackTimeoutMs ?? DEFAULT_MCP_OAUTH_CALLBACK_TIMEOUT_MS,
            openAuthorizationUrl:
              input.openAuthorizationUrl ??
              (async (authorizationUrl) => {
                await open(authorizationUrl.href);
              }),
            allowInteractiveAuthorization: input.allowInteractiveAuthorization ?? false,
          })
        : undefined;
      try {
        const client = await createMCPClient({
          transport: {
            type: input.entry.transport,
            url,
            ...(input.entry.headers ? { headers: { ...input.entry.headers } } : {}),
            ...(oauthProvider ? { authProvider: oauthProvider } : {}),
            redirect: "error",
          },
        });
        return oauthProvider ? attachClientClose(client, () => oauthProvider.close()) : client;
      } catch (error) {
        if (oauthProvider && error instanceof UnauthorizedError) {
          const client = await createMCPClient({
            transport: {
              type: input.entry.transport,
              url,
              ...(input.entry.headers ? { headers: { ...input.entry.headers } } : {}),
              authProvider: oauthProvider,
              redirect: "error",
            },
          });
          return attachClientClose(client, () => oauthProvider.close());
        }
        if (oauthProvider) {
          await oauthProvider.close();
        }
        throw error;
      }
    }
  }
}

function normalizeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return fallback;
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  if (timeoutMs <= 0) {
    return operation;
  }

  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function safelyCloseClient(client: MCPClient): Promise<void> {
  await Promise.allSettled([client.close()]);
}

export async function buildProviderMcpToolRuntime(
  input: {
    readonly provider: ProviderKind;
    readonly servers: ReadonlyArray<McpServerEntry>;
    readonly cwd?: string;
  },
  options: BuildProviderMcpToolRuntimeOptions = {},
): Promise<ProviderMcpToolRuntime> {
  // ShioriCode-native MCP runtime:
  // - resolves provider-scoped servers from ShioriCode settings
  // - connects to each server in isolation (no single-server fail-stop)
  // - exposes namespaced tool descriptors/executors for hosted Shiori turns
  const createClient =
    options.createClient ??
    ((clientInput) =>
      createMcpClientForEntry({
        ...clientInput,
        ...(options.oauthStorageDir ? { oauthStorageDir: options.oauthStorageDir } : {}),
        ...(options.oauthCallbackTimeoutMs
          ? { oauthCallbackTimeoutMs: options.oauthCallbackTimeoutMs }
          : {}),
        ...(options.openAuthorizationUrl
          ? { openAuthorizationUrl: options.openAuthorizationUrl }
          : {}),
        allowInteractiveAuthorization: options.allowInteractiveOAuth ?? false,
      }));
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS;
  const oauthConnectTimeoutMs = options.oauthStorageDir
    ? Math.max(
        connectTimeoutMs,
        (options.oauthCallbackTimeoutMs ?? DEFAULT_MCP_OAUTH_CALLBACK_TIMEOUT_MS) + 5_000,
      )
    : connectTimeoutMs;
  const listToolsTimeoutMs = options.listToolsTimeoutMs ?? DEFAULT_MCP_LIST_TOOLS_TIMEOUT_MS;
  const providerServers = filterMcpServersForProvider(input.provider, input.servers);

  const clients: MCPClient[] = [];
  const descriptors: ProviderMcpDescriptor[] = [];
  const executors = new Map<string, ProviderMcpToolExecutor>();
  const warnings: string[] = [];
  let closed = false;

  const serverResults = await Promise.allSettled(
    providerServers.map(async (entry) => {
      let client: MCPClient | null = null;
      const entryConnectTimeoutMs =
        entry.transport === "stdio" ? connectTimeoutMs : oauthConnectTimeoutMs;
      try {
        client = await withTimeout(
          createClient({
            entry,
            ...(input.cwd ? { cwd: input.cwd } : {}),
          }),
          entryConnectTimeoutMs,
          `Timed out connecting to MCP server '${entry.name}' after ${entryConnectTimeoutMs}ms.`,
        );

        const definitions = await withTimeout(
          client.listTools(),
          listToolsTimeoutMs,
          `Timed out loading tools from MCP server '${entry.name}' after ${listToolsTimeoutMs}ms.`,
        );

        const toolSet = client.toolsFromDefinitions(definitions);
        return { entry, client, definitions, toolSet };
      } catch (error) {
        if (client) {
          await safelyCloseClient(client);
        }
        throw error;
      }
    }),
  );

  for (let index = 0; index < serverResults.length; index += 1) {
    const result = serverResults[index];
    const entry = providerServers[index];
    if (!result || !entry) {
      continue;
    }

    if (result.status === "rejected") {
      warnings.push(
        `Failed to initialize MCP server '${entry.name}' (${entry.transport}): ${normalizeErrorMessage(
          result.reason,
          "unknown error",
        )}`,
      );
      continue;
    }

    const { client, definitions, toolSet } = result.value;
    clients.push(client);

    for (const tool of definitions.tools) {
      const prefixedName = prefixedShioriToolName(entry.name, tool.name);
      if (executors.has(prefixedName)) {
        warnings.push(`Skipping duplicate MCP tool '${tool.name}' from server '${entry.name}'.`);
        continue;
      }

      const executable = toolSet[tool.name as keyof typeof toolSet] as
        | {
            execute: (input: Record<string, unknown>, options: unknown) => unknown;
          }
        | undefined;
      if (!executable || typeof executable.execute !== "function") {
        warnings.push(
          `Skipping MCP tool '${tool.name}' from server '${entry.name}' because it is not executable.`,
        );
        continue;
      }

      descriptors.push({
        name: prefixedName,
        title:
          typeof tool.title === "string" && tool.title.trim().length > 0
            ? `${entry.name} · ${tool.title}`
            : `${entry.name} · ${tool.name}`,
        description: resolveMcpToolDescription(tool),
        inputSchema:
          tool.inputSchema && typeof tool.inputSchema === "object"
            ? (tool.inputSchema as Record<string, unknown>)
            : {
                type: "object",
                properties: {},
                additionalProperties: true,
              },
      });

      executors.set(prefixedName, {
        title:
          typeof tool.title === "string" && tool.title.trim().length > 0
            ? `${entry.name} · ${tool.title}`
            : `${entry.name} · ${tool.name}`,
        execute: async (toolInput) =>
          await Promise.resolve(
            executable.execute(toolInput, {
              messages: [],
              toolCallId: prefixedName,
            } as unknown),
          ),
      });
    }
  }

  return {
    descriptors,
    executors,
    warnings,
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.allSettled(clients.map((client) => client.close()));
    },
  };
}

function escapeTomlString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/"/g, '\\"')}"`;
}

function escapeTomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : escapeTomlString(value);
}

export function buildCodexManagedMcpConfigFragment(
  servers: ReadonlyArray<McpServerEntry>,
): string | null {
  const managedServers = filterMcpServersForProvider("codex", servers);
  if (managedServers.length === 0) {
    return null;
  }

  const lines: string[] = ["# ShioriCode managed MCP servers"];
  for (const server of managedServers) {
    const tableName = `shioricode_${sanitizeIdentifier(server.name, "server")}`;
    const tablePath = `mcp_servers.${escapeTomlKey(tableName)}`;

    if (server.transport === "stdio") {
      const command = server.command?.trim();
      if (!command) {
        continue;
      }
      lines.push("", `[${tablePath}]`);
      lines.push(`command = ${escapeTomlString(command)}`);
      if (server.args && server.args.length > 0) {
        lines.push(`args = [${server.args.map(escapeTomlString).join(", ")}]`);
      }
      if (server.env && Object.keys(server.env).length > 0) {
        lines.push(`[${tablePath}.env]`);
        for (const [key, value] of Object.entries(server.env)) {
          lines.push(`${escapeTomlKey(key)} = ${escapeTomlString(value)}`);
        }
      }
      continue;
    }

    const url = server.url?.trim();
    if (!url) {
      continue;
    }
    lines.push("", `[${tablePath}]`);
    lines.push(`url = ${escapeTomlString(url)}`);
    if (server.transport === "sse") {
      lines.push(`transport = "sse"`);
    }
    if (server.headers && Object.keys(server.headers).length > 0) {
      lines.push(`[${tablePath}.http_headers]`);
      for (const [key, value] of Object.entries(server.headers)) {
        lines.push(`${escapeTomlKey(key)} = ${escapeTomlString(value)}`);
      }
    }
  }

  return lines.length > 1 ? `${lines.join("\n")}\n` : null;
}

function sanitizeCodexAppServerProfile(profile: TomlTable): TomlTable {
  const sanitized: TomlTable = { ...profile };
  const features = { ...readTomlTable(profile.features) };
  const analytics = readTomlTable(profile.analytics) ?? {};
  const apps = readTomlTable(profile.apps);
  const defaultAppSettings = readTomlTable(apps?._default);

  delete features.connectors;

  sanitized.features = {
    ...features,
    apps: false,
    plugins: false,
  };
  sanitized.analytics = {
    ...analytics,
    enabled: false,
  };
  sanitized.include_apps_instructions = false;
  sanitized.apps = {
    _default: {
      ...defaultAppSettings,
      enabled: false,
    },
  };

  return sanitized;
}

export function buildCodexLeanAppServerConfig(input: {
  readonly baseConfig: string;
  readonly servers: ReadonlyArray<McpServerEntry>;
}): string {
  const parsed = input.baseConfig.trim().length > 0 ? parseToml(input.baseConfig) : {};
  const config: TomlTable = { ...(parsed as TomlTable) };

  delete config.plugins;
  delete config.marketplaces;
  delete config.mcp_servers;
  delete config.mcpServers;

  const features = { ...readTomlTable(config.features) };
  const analytics = readTomlTable(config.analytics) ?? {};
  const feedback = readTomlTable(config.feedback) ?? {};
  const history = readTomlTable(config.history) ?? {};
  const apps = readTomlTable(config.apps);
  const defaultAppSettings = readTomlTable(apps?._default);
  const profiles = readTomlTable(config.profiles);

  delete features.connectors;

  config.features = {
    ...features,
    apps: false,
    plugins: false,
  };
  config.analytics = {
    ...analytics,
    enabled: false,
  };
  config.feedback = {
    ...feedback,
    enabled: false,
  };
  config.history = {
    ...history,
    persistence: "none",
  };
  config.include_apps_instructions = false;
  config.apps = {
    _default: {
      ...defaultAppSettings,
      enabled: false,
    },
  };

  if (profiles) {
    config.profiles = Object.fromEntries(
      Object.entries(profiles).flatMap(([profileName, profileValue]) => {
        const profileTable = readTomlTable(profileValue);
        return profileTable ? [[profileName, sanitizeCodexAppServerProfile(profileTable)]] : [];
      }),
    );
  }

  const managedFragment = buildCodexManagedMcpConfigFragment(input.servers);
  if (managedFragment) {
    const managedConfig = parseToml(managedFragment);
    const managedServers = readTomlTable(managedConfig.mcp_servers ?? managedConfig.mcpServers);
    if (managedServers) {
      config.mcp_servers = managedServers;
    }
  }

  return stringifyToml(config);
}

function resolveCodexHomePath(homePath?: string): string {
  return homePath?.trim() ? homePath.trim() : path.join(homedir(), ".codex");
}

async function maybeCopyFile(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await copyFile(sourcePath, targetPath);
  } catch {
    // Missing optional files are fine.
  }
}

async function maybeMirrorDirectory(sourcePath: string, targetPath: string): Promise<void> {
  try {
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isDirectory()) {
      return;
    }
  } catch {
    return;
  }

  try {
    await symlink(sourcePath, targetPath, process.platform === "win32" ? "junction" : "dir");
  } catch {
    await cp(sourcePath, targetPath, { recursive: true, force: true });
  }
}

export async function prepareCodexHomeWithManagedMcpServers(input: {
  readonly threadId: string;
  readonly runtimeRootDir: string;
  readonly homePath?: string;
  readonly servers: ReadonlyArray<McpServerEntry>;
}): Promise<{ homePath: string; cleanup: () => Promise<void> } | null> {
  if (input.servers.length === 0) {
    return null;
  }

  const sourceHome = resolveCodexHomePath(input.homePath);
  const targetHome = path.join(
    input.runtimeRootDir,
    "codex-mcp-homes",
    sanitizeIdentifier(input.threadId, "thread"),
    randomUUID(),
  );

  await mkdir(targetHome, { recursive: true });
  await maybeCopyFile(path.join(sourceHome, "auth.json"), path.join(targetHome, "auth.json"));
  await maybeMirrorDirectory(path.join(sourceHome, "skills"), path.join(targetHome, "skills"));

  const baseConfig = await readFile(path.join(sourceHome, "config.toml"), "utf8").catch(() => "");
  const mergedConfig = buildCodexLeanAppServerConfig({
    baseConfig,
    servers: input.servers,
  });
  await writeFile(path.join(targetHome, "config.toml"), mergedConfig, "utf8");

  return {
    homePath: targetHome,
    cleanup: async () => {
      await rm(targetHome, { recursive: true, force: true });
    },
  };
}
