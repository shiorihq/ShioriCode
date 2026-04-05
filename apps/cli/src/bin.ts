import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CommandId, ProjectId, ThreadId } from "contracts";
import { version } from "../package.json" with { type: "json" };
import {
  createThreadForProject,
  ensureProjectForCwd,
  formatThreadLine,
  openInBrowser,
  requireThread,
  resolveCliBaseDir,
  resolveHttpUrl,
  sendThreadMessage,
  withCliContext,
} from "./lib";

export function printHelp(): void {
  console.log(`shiori ${version}

Usage:
  shiori open [<folder>]
  shiori status
  shiori project list
  shiori project add <cwd> [--title <title>]
  shiori thread list [--project <project-id>]
  shiori thread create [--project <project-id> | --cwd <cwd>] [--title <title>]
  shiori thread rename <thread-id> <title>
  shiori thread archive <thread-id>
  shiori thread unarchive <thread-id>
  shiori thread delete <thread-id>
  shiori thread send <thread-id> <message>
  shiori session interrupt <thread-id>
  shiori session stop <thread-id>

Options:
  --base-dir <path>  Override SHIORICODE_HOME for this command.
  --help             Show this help.
  --version          Show the CLI version.
`);
}

function parseGlobalOptions(argv: string[]) {
  const args = [...argv];
  let baseDir: string | undefined;

  for (let index = 0; index < args.length; ) {
    const current = args[index];
    if (current === "--base-dir") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--base-dir requires a value.");
      }
      baseDir = value;
      args.splice(index, 2);
      continue;
    }
    index += 1;
  }

  return {
    args,
    baseDir: resolveCliBaseDir(baseDir),
  };
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  args.splice(index, 2);
  return value;
}

export async function main(rawArgs: string[]): Promise<void> {
  if (rawArgs.includes("--help")) {
    printHelp();
    return;
  }
  if (rawArgs.includes("--version")) {
    console.log(version);
    return;
  }

  const { args, baseDir } = parseGlobalOptions(rawArgs);
  const [subject, action, ...rest] = args;

  if (!subject) {
    printHelp();
    return;
  }

  if (subject === "open") {
    const folder = path.resolve(action ?? process.cwd());
    await withCliContext({ baseDir }, async ({ rpc, snapshot }) => {
      await ensureProjectForCwd(rpc, snapshot, folder);
      const httpUrl = await resolveHttpUrl(baseDir);
      await openInBrowser(httpUrl);
      console.log(`Opened ${folder} in ShioriCode at ${httpUrl}`);
    });
    return;
  }

  if (subject === "status") {
    await withCliContext({ baseDir }, async ({ snapshot }) => {
      console.log(`Base dir: ${baseDir}`);
      console.log(`Projects: ${snapshot.projects.length}`);
      console.log(`Threads: ${snapshot.threads.length}`);
      console.log(`Updated: ${snapshot.updatedAt}`);
    });
    return;
  }

  if (subject === "project" && action === "list") {
    await withCliContext({ baseDir }, async ({ snapshot }) => {
      for (const project of snapshot.projects) {
        console.log(`${project.id}  ${project.title}  ${project.workspaceRoot}`);
      }
    });
    return;
  }

  if (subject === "project" && action === "add") {
    const cwd = rest[0];
    if (!cwd) {
      throw new Error("project add requires a <cwd> argument.");
    }
    const mutableArgs = rest.slice(1);
    const title = parseFlagValue(mutableArgs, "--title");
    await withCliContext({ baseDir }, async ({ rpc, snapshot }) => {
      const projectId = await ensureProjectForCwd(rpc, snapshot, cwd, title);
      console.log(projectId);
    });
    return;
  }

  if (subject === "thread" && action === "list") {
    const mutableArgs = [...rest];
    const projectId = parseFlagValue(mutableArgs, "--project");
    await withCliContext({ baseDir }, async ({ snapshot }) => {
      const projectsById = new Map(snapshot.projects.map((project) => [project.id, project.title]));
      const threads = snapshot.threads
        .filter((thread) => thread.archivedAt === null)
        .filter((thread) => (projectId ? thread.projectId === projectId : true))
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      for (const thread of threads) {
        console.log(formatThreadLine(thread, projectsById.get(thread.projectId)));
      }
    });
    return;
  }

  if (subject === "thread" && action === "create") {
    const mutableArgs = [...rest];
    const projectId = parseFlagValue(mutableArgs, "--project");
    const cwd = parseFlagValue(mutableArgs, "--cwd") ?? process.cwd();
    const title = parseFlagValue(mutableArgs, "--title");
    await withCliContext({ baseDir }, async ({ rpc, snapshot }) => {
      const targetProjectId = projectId
        ? ProjectId.makeUnsafe(projectId)
        : await ensureProjectForCwd(rpc, snapshot, cwd);
      const threadId = await createThreadForProject({
        rpc,
        snapshot,
        projectId: targetProjectId,
        ...(title ? { title } : {}),
      });
      console.log(threadId);
    });
    return;
  }

  if (subject === "thread" && action === "rename") {
    const threadId = rest[0];
    const title = rest.slice(1).join(" ").trim();
    if (!threadId || !title) {
      throw new Error("thread rename requires <thread-id> and <title>.");
    }
    await withCliContext({ baseDir }, async ({ rpc }) => {
      await rpc.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe(randomUUID()),
        threadId: ThreadId.makeUnsafe(threadId),
        title,
      });
      console.log(threadId);
    });
    return;
  }

  if (subject === "thread" && ["archive", "unarchive", "delete"].includes(action ?? "")) {
    const threadId = rest[0];
    if (!threadId) {
      throw new Error(`thread ${action} requires <thread-id>.`);
    }
    await withCliContext({ baseDir }, async ({ rpc }) => {
      await rpc.orchestration.dispatchCommand({
        type: `thread.${action}` as "thread.archive" | "thread.unarchive" | "thread.delete",
        commandId: CommandId.makeUnsafe(randomUUID()),
        threadId: ThreadId.makeUnsafe(threadId),
      });
      console.log(threadId);
    });
    return;
  }

  if (subject === "thread" && action === "send") {
    const threadId = rest[0];
    const message = rest.slice(1).join(" ").trim();
    if (!threadId || !message) {
      throw new Error("thread send requires <thread-id> and <message>.");
    }
    await withCliContext({ baseDir }, async ({ rpc, snapshot }) => {
      await sendThreadMessage({ rpc, snapshot, threadId, message });
      console.log(threadId);
    });
    return;
  }

  if (subject === "session" && (action === "interrupt" || action === "stop")) {
    const threadId = rest[0];
    if (!threadId) {
      throw new Error(`session ${action} requires <thread-id>.`);
    }
    await withCliContext({ baseDir }, async ({ rpc, snapshot }) => {
      const thread = requireThread(snapshot, threadId);
      if (action === "interrupt") {
        await rpc.orchestration.dispatchCommand({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe(randomUUID()),
          threadId: thread.id,
          ...(thread.latestTurn?.turnId ? { turnId: thread.latestTurn.turnId } : {}),
          createdAt: new Date().toISOString(),
        });
      } else {
        await rpc.orchestration.dispatchCommand({
          type: "thread.session.stop",
          commandId: CommandId.makeUnsafe(randomUUID()),
          threadId: thread.id,
          createdAt: new Date().toISOString(),
        });
      }
      console.log(threadId);
    });
    return;
  }

  throw new Error(`Unknown command: ${[subject, action].filter(Boolean).join(" ")}`);
}

function isDirectExecution(): boolean {
  const entryPath = process.argv[1];
  if (!entryPath) {
    return false;
  }
  try {
    const resolved = fs.realpathSync(path.resolve(entryPath));
    return import.meta.url === pathToFileURL(resolved).href;
  } catch {
    return import.meta.url === pathToFileURL(path.resolve(entryPath)).href;
  }
}

if (isDirectExecution()) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
