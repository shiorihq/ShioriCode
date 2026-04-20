#!/usr/bin/env node

import { cpSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cliDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(cliDir, "..", "..");
const webDir = path.join(repoRoot, "apps", "web");
const serverDir = path.join(repoRoot, "apps", "server");
const cliDistDir = path.join(cliDir, "dist");
const bundledBackendDir = path.join(cliDistDir, "backend");

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("bun", ["run", "build"], webDir);
run("bun", ["run", "build"], serverDir);
run("bunx", ["tsdown"], cliDir);

rmSync(bundledBackendDir, { force: true, recursive: true });
cpSync(path.join(serverDir, "dist"), bundledBackendDir, { recursive: true });
