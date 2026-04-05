import { spawn } from "node:child_process";
import { join } from "node:path";
import { desktopDir } from "./electron-launcher.mjs";

function resolveBunExecutable() {
  return /bun(?:\.exe)?$/i.test(process.execPath) ? process.execPath : "bun";
}

const bun = resolveBunExecutable();
/** @type {import("node:child_process").ChildProcess[]} */
const children = [];
let shuttingDown = false;

function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) {
      continue;
    }

    child.kill("SIGTERM");
  }

  setTimeout(() => process.exit(exitCode), 400).unref();
}

function start(command, options = {}) {
  const child = spawn(bun, command, {
    cwd: options.cwd ?? desktopDir,
    stdio: "inherit",
    env: process.env,
  });

  children.push(child);

  child.once("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }

    const interrupted = code === 130 || code === 143 || code === 129;
    const failed = signal !== null || (typeof code === "number" && code !== 0 && !interrupted);

    if (failed) {
      shutdown(typeof code === "number" && code !== 0 ? code : 1);
    }
  });
}

start(["run", "dev:bundle"]);
start(["run", "dev:bundle"], { cwd: join(desktopDir, "../server") });
start(["run", "dev:electron"]);

process.once("SIGINT", () => {
  shutdown(130);
});
process.once("SIGTERM", () => {
  shutdown(143);
});
process.once("SIGHUP", () => {
  shutdown(129);
});
