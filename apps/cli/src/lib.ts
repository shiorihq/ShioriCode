import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "contracts";
import { decodeServerInstanceRecord, getServerInstancePath } from "shared/serverInstance";
import { createWsRpcClient, type WsRpcClient } from "shared/wsRpc";

export interface CliContext {
  readonly baseDir: string;
  readonly rpc: WsRpcClient;
  readonly snapshot: OrchestrationReadModel;
}

export function resolveCliBaseDir(explicitBaseDir?: string): string {
  const raw = explicitBaseDir?.trim() || process.env.SHIORICODE_HOME?.trim();
  if (!raw) {
    return path.join(os.homedir(), ".shiori");
  }
  if (raw === "~") {
    return os.homedir();
  }
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return path.resolve(raw);
}

export async function withCliContext<T>(
  input: { readonly baseDir?: string },
  run: (context: CliContext) => Promise<T>,
): Promise<T> {
  const baseDir = resolveCliBaseDir(input.baseDir);
  const rpc = await connectOrStartBackend(baseDir);
  try {
    const snapshot = await rpc.orchestration.getSnapshot();
    return await run({ baseDir, rpc, snapshot });
  } finally {
    await rpc.dispose();
  }
}

export async function connectOrStartBackend(baseDir: string): Promise<WsRpcClient> {
  const existing = await connectToRecordedBackend(baseDir);
  if (existing) {
    return existing;
  }

  await startBackend(baseDir);
  const started = await waitForBackend(baseDir);
  if (!started) {
    throw new Error("Shiori backend did not become ready.");
  }
  return started;
}

async function connectToRecordedBackend(baseDir: string): Promise<WsRpcClient | null> {
  const instancePath = getServerInstancePath(baseDir);
  if (!fs.existsSync(instancePath)) {
    return null;
  }

  try {
    const raw = await fs.promises.readFile(instancePath, "utf8");
    const record = decodeServerInstanceRecord(JSON.parse(raw));
    const rpc = createWsRpcClient({ url: record.wsUrl });
    await rpc.server.getConfig();
    return rpc;
  } catch {
    return null;
  }
}

async function startBackend(baseDir: string): Promise<void> {
  const backendEntry = resolveBackendEntry();
  const authToken = randomUUID();
  const child = spawn(process.execPath, [backendEntry, "--bootstrap-fd", "3"], {
    cwd: process.cwd(),
    env: backendChildEnv(),
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "pipe"],
  });

  const bootstrapStream = child.stdio[3];
  if (!bootstrapStream || !("write" in bootstrapStream)) {
    child.kill("SIGTERM");
    throw new Error("Failed to open bootstrap pipe for the backend process.");
  }

  bootstrapStream.write(
    `${JSON.stringify({
      mode: "web",
      noBrowser: true,
      shioriCodeHome: baseDir,
      authToken,
    })}\n`,
  );
  bootstrapStream.end();
  child.unref();
}

function backendChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.SHIORICODE_PORT;
  delete env.SHIORICODE_AUTH_TOKEN;
  delete env.SHIORICODE_MODE;
  delete env.SHIORICODE_NO_BROWSER;
  delete env.SHIORICODE_HOST;
  return env;
}

function resolveBackendEntry(): string {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("shioricode/package.json");
  return path.join(path.dirname(packageJsonPath), "dist", "bin.mjs");
}

async function waitForBackend(baseDir: string, timeoutMs = 15_000): Promise<WsRpcClient | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const existing = await connectToRecordedBackend(baseDir);
    if (existing) {
      return existing;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return null;
}

export async function resolveHttpUrl(baseDir: string): Promise<string> {
  const instancePath = getServerInstancePath(baseDir);
  const raw = await fs.promises.readFile(instancePath, "utf8");
  const record = decodeServerInstanceRecord(JSON.parse(raw));
  return `http://localhost:${record.port}`;
}

export async function openInBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const child = spawn(command, [url], { detached: true, stdio: "ignore" });
  child.unref();
}

export async function ensureProjectForCwd(
  rpc: WsRpcClient,
  snapshot: OrchestrationReadModel,
  cwd: string,
  title?: string,
): Promise<ProjectId> {
  const normalizedCwd = path.resolve(cwd);
  const existing = snapshot.projects.find((project) => project.workspaceRoot === normalizedCwd);
  if (existing) {
    return existing.id;
  }

  const settings = await rpc.server.getSettings();
  const projectId = ProjectId.makeUnsafe(randomUUID());
  const createdAt = new Date().toISOString();
  await rpc.orchestration.dispatchCommand({
    type: "project.create",
    commandId: CommandId.makeUnsafe(randomUUID()),
    projectId,
    title: title?.trim() || path.basename(normalizedCwd) || normalizedCwd,
    workspaceRoot: normalizedCwd,
    defaultModelSelection: settings.defaultModelSelection,
    createdAt,
  });

  return projectId;
}

export async function createThreadForProject(input: {
  readonly rpc: WsRpcClient;
  readonly snapshot: OrchestrationReadModel;
  readonly projectId: ProjectId;
  readonly title?: string;
}): Promise<ThreadId> {
  const project = input.snapshot.projects.find((entry) => entry.id === input.projectId);
  const settings = await input.rpc.server.getSettings();
  const modelSelection =
    project?.defaultModelSelection ??
    settings.defaultModelSelection ??
    input.snapshot.projects[0]?.defaultModelSelection;
  if (!modelSelection) {
    throw new Error("Could not resolve a default model selection for the new thread.");
  }

  const threadId = ThreadId.makeUnsafe(randomUUID());
  await input.rpc.orchestration.dispatchCommand({
    type: "thread.create",
    commandId: CommandId.makeUnsafe(randomUUID()),
    threadId,
    projectId: input.projectId,
    title: input.title?.trim() || "New Thread",
    modelSelection,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    createdAt: new Date().toISOString(),
  });
  return threadId;
}

export function requireThread(
  snapshot: OrchestrationReadModel,
  threadId: string,
): OrchestrationThread {
  const thread = snapshot.threads.find((entry) => entry.id === threadId);
  if (!thread) {
    throw new Error(`Thread '${threadId}' does not exist.`);
  }
  return thread;
}

export async function sendThreadMessage(input: {
  readonly rpc: WsRpcClient;
  readonly snapshot: OrchestrationReadModel;
  readonly threadId: string;
  readonly message: string;
}): Promise<void> {
  const thread = requireThread(input.snapshot, input.threadId);
  await input.rpc.orchestration.dispatchCommand({
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(randomUUID()),
    threadId: thread.id,
    message: {
      messageId: MessageId.makeUnsafe(randomUUID()),
      role: "user",
      text: input.message,
      attachments: [],
    },
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    createdAt: new Date().toISOString(),
  });
}

export function formatThreadLine(
  thread: OrchestrationThread,
  projectTitle: string | undefined,
): string {
  const status = thread.session?.status ?? "idle";
  return `${thread.id}  ${thread.title}  [${status}]${projectTitle ? `  ${projectTitle}` : ""}`;
}

export function formatModel(modelSelection: ModelSelection): string {
  return `${modelSelection.provider}:${modelSelection.model}`;
}
