import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
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
const timeoutMs = 30_000;
const maxOutputBytes = 200_000;
const smokeEnv = { ...process.env };
delete smokeEnv.VITE_DEV_SERVER_URL;

console.log("\nLaunching Electron smoke test...");

const debugPort = await reserveLoopbackPort();
const child = spawn(
  electronBin,
  [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${smokeUserData}`, mainJs],
  {
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...smokeEnv,
      ELECTRON_ENABLE_LOGGING: "1",
      SHIORICODE_HOME: smokeHome,
    },
  },
);

let output = "";
let settled = false;
let timeout = null;
let poll = null;
let rendererBridgeCheckStarted = false;

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

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to reserve renderer debug port.")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function readDevToolsTargets() {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
  if (!response.ok) {
    throw new Error(`DevTools target list returned HTTP ${response.status}.`);
  }
  return response.json();
}

async function evaluateRendererExpression(webSocketDebuggerUrl, expression) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) {
      return;
    }
    pending.get(message.id)(message);
    pending.delete(message.id);
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener(
      "error",
      () => reject(new Error("Unable to connect to renderer DevTools socket.")),
      { once: true },
    );
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const message = { id: ++nextId, method, params };
      pending.set(message.id, resolve);
      ws.send(JSON.stringify(message));
    });

  try {
    await send("Runtime.enable");
    const response = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return response.result?.result?.value;
  } finally {
    ws.close();
  }
}

async function waitForRendererBridge(expectedWsUrl) {
  const deadline = Date.now() + 10_000;
  let lastProbe = null;

  while (Date.now() < deadline) {
    try {
      const targets = await readDevToolsTargets();
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) {
        lastProbe = await evaluateRendererExpression(
          page.webSocketDebuggerUrl,
          `({
            href: location.href,
            title: document.title,
            desktopBridge: typeof window.desktopBridge,
            wsUrl: window.desktopBridge?.getWsUrl?.() ?? null,
            nativeApi: typeof window.nativeApi,
            bodyText: document.body?.innerText ?? "",
          })`,
        );
        if (lastProbe?.desktopBridge === "object" && lastProbe.wsUrl === expectedWsUrl) {
          return;
        }
      }
    } catch (error) {
      lastProbe = { error: error instanceof Error ? error.message : String(error) };
    }

    await wait(100);
  }

  throw new Error(
    `desktop bridge was not exposed to renderer with expected websocket URL: ${JSON.stringify({
      expectedWsUrl,
      lastProbe,
    })}`,
  );
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
  if (serverInstance?.wsUrl && !rendererBridgeCheckStarted) {
    rendererBridgeCheckStarted = true;
    void waitForRendererBridge(serverInstance.wsUrl)
      .then(() => {
        finishSuccess();
      })
      .catch((error) => {
        finishFailure(error instanceof Error ? error.message : String(error));
      });
  }
}, 100);

timeout = setTimeout(() => {
  finishFailure(`server did not become ready within ${timeoutMs}ms`);
}, timeoutMs);

child.on("exit", (code, signal) => {
  if (settled) return;
  finishFailure(`Electron exited before server readiness (code=${code} signal=${signal})`);
});
