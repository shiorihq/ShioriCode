import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CURSOR_SDK_VERSION = "1.0.17";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cursorSdkRoot = path.join(repoRoot, "node_modules", "@cursor", "sdk");

const targets = [
  {
    path: path.join(cursorSdkRoot, "dist", "esm", "index.js"),
    logger: "runtimeLogger",
  },
  {
    path: path.join(cursorSdkRoot, "dist", "cjs", "index.js"),
    logger: "pV",
  },
];

function countOccurrences(source, value) {
  return source.split(value).length - 1;
}

async function patchTarget(target) {
  const source = await readFile(target.path, "utf8");
  const retry = `catch(e){return ${target.logger}.warn("[default-local-workspace-runtime] Failed to initialize MCP-enabled runtime, retrying without MCP:"`;
  const strict = `catch(e){if(I)throw e;return ${target.logger}.warn("[default-local-workspace-runtime] Failed to initialize MCP-enabled runtime, retrying without MCP:"`;
  const retryCount = countOccurrences(source, retry);
  const strictCount = countOccurrences(source, strict);

  if (strictCount === 1 && retryCount === 0) {
    return;
  }
  if (retryCount !== 1 || strictCount !== 0) {
    throw new Error(
      `Refusing to patch unexpected @cursor/sdk bundle '${target.path}' (retry=${retryCount}, strict=${strictCount}).`,
    );
  }

  await writeFile(target.path, source.replace(retry, strict), "utf8");
}

const packageJson = JSON.parse(await readFile(path.join(cursorSdkRoot, "package.json"), "utf8"));
if (packageJson.version !== CURSOR_SDK_VERSION) {
  throw new Error(
    `Strict MCP patch supports @cursor/sdk ${CURSOR_SDK_VERSION}, found ${String(packageJson.version)}.`,
  );
}

await Promise.all(targets.map(patchTarget));
