import React from "react";
import { render } from "ink";

import { AppWithController } from "./App";

function parseArgs(argv: string[]) {
  const args = [...argv];
  let baseDir: string | undefined;
  let cwd: string | undefined;
  let projectId: string | undefined;
  let threadId: string | undefined;
  let newThread = false;

  for (let index = 0; index < args.length; ) {
    const current = args[index];
    if (current === "--base-dir") {
      baseDir = args[index + 1];
      args.splice(index, 2);
      continue;
    }
    if (current === "--cwd") {
      cwd = args[index + 1];
      args.splice(index, 2);
      continue;
    }
    if (current === "--project") {
      projectId = args[index + 1];
      args.splice(index, 2);
      continue;
    }
    if (current === "--thread") {
      threadId = args[index + 1];
      args.splice(index, 2);
      continue;
    }
    if (current === "--new-thread") {
      newThread = true;
      args.splice(index, 1);
      continue;
    }
    if (current === "--help") {
      process.stdout.write(`shiori-agent

Usage:
  shiori-agent [--base-dir <path>] [--cwd <path>] [--project <project-id>] [--thread <thread-id>] [--new-thread]
`);
      process.exit(0);
    }
    index += 1;
  }

  return {
    baseDir,
    cwd,
    projectId,
    threadId,
    newThread,
  };
}

const options = parseArgs(process.argv.slice(2));

render(
  <AppWithController
    {...(options.baseDir ? { baseDir: options.baseDir } : {})}
    {...(options.cwd ? { cwd: options.cwd } : {})}
    {...(options.projectId ? { projectId: options.projectId } : {})}
    {...(options.threadId ? { threadId: options.threadId } : {})}
    {...(options.newThread ? { newThread: true } : {})}
  />,
);
