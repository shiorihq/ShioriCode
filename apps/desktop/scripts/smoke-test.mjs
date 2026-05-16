import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const moduleDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(moduleDir, "..");
const electronBin = require("electron");
const mainJs = resolve(desktopDir, "dist-electron/main.js");
const smokeHome = mkdtempSync(resolve(tmpdir(), "shioricode-smoke-"));
const smokeUserData = mkdtempSync(resolve(tmpdir(), "shioricode-smoke-userdata-"));
const serverInstancePath = resolve(smokeHome, "server-instance.json");
const timeoutMs = 20_000;
const maxOutputBytes = 200_000;
const smokeEnv = { ...process.env };
delete smokeEnv.VITE_DEV_SERVER_URL;

console.log("\nLaunching Electron smoke test...");

const child = spawn(electronBin, [`--user-data-dir=${smokeUserData}`, mainJs], {
  detached: process.platform !== "win32",
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...smokeEnv,
    ELECTRON_ENABLE_LOGGING: "1",
    SHIORICODE_HOME: smokeHome,
  },
});

let output = "";
let settled = false;
let timeout = null;
let poll = null;

const fatalPatterns = [
  "Cannot find module",
  "MODULE_NOT_FOUND",
  "Refused to execute",
  "Uncaught Error",
  "Uncaught Exception",
  "Uncaught TypeError",
  "Uncaught ReferenceError",
  "EPIPE",
  "Service not found",
  "backend exited unexpectedly",
];

function appendOutput(chunk) {
  output += chunk.toString();
  if (output.length > maxOutputBytes) {
    output = output.slice(-maxOutputBytes);
  }
}

function killChild(signal = "SIGTERM") {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may already have exited.
    }
  }
}

function clearTimers() {
  if (timeout) {
    clearTimeout(timeout);
    timeout = null;
  }
  if (poll) {
    clearInterval(poll);
    poll = null;
  }
}

function finishSuccess() {
  if (settled) return;
  settled = true;
  clearTimers();
  killChild();
  console.log("Desktop smoke test passed.");
  process.exit(0);
}

function finishFailure(message) {
  if (settled) return;
  settled = true;
  clearTimers();
  killChild();
  console.error(`\nDesktop smoke test failed: ${message}`);
  console.error("\nFull output:\n" + output);
  process.exit(1);
}

function readServerInstance() {
  if (!existsSync(serverInstancePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(serverInstancePath, "utf8"));
  } catch {
    return null;
  }
}

child.stdout.on("data", (chunk) => {
  appendOutput(chunk);
});
child.stderr.on("data", (chunk) => {
  appendOutput(chunk);
});

poll = setInterval(() => {
  const failures = fatalPatterns.filter((pattern) => output.includes(pattern));
  if (failures.length > 0) {
    finishFailure(`matched fatal output: ${failures.join(", ")}`);
    return;
  }

  const serverInstance = readServerInstance();
  if (serverInstance?.wsUrl) {
    finishSuccess();
  }
}, 100);

timeout = setTimeout(() => {
  finishFailure(`server did not become ready within ${timeoutMs}ms`);
}, timeoutMs);

child.on("exit", (code, signal) => {
  if (settled) return;
  finishFailure(`Electron exited before server readiness (code=${code} signal=${signal})`);
});
