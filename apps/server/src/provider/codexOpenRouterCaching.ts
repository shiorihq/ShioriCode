import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { parse as parseToml, type TomlTable, type TomlValue } from "smol-toml";

const OPENROUTER_HOSTNAME = "openrouter.ai";
export const OPENROUTER_CACHE_HEADER = "X-OpenRouter-Cache";
export const OPENROUTER_CACHE_VALUE = "true";

function readTomlTable(value: TomlValue | undefined): TomlTable | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as TomlTable)
    : undefined;
}

function resolveCodexHomePath(homePath?: string): string {
  return homePath?.trim() ? homePath.trim() : path.join(homedir(), ".codex");
}

function parentDirsFromRoot(startPath: string | undefined): string[] {
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
  return dirs.reverse();
}

function codexConfigPaths(input: { readonly homePath?: string; readonly cwd?: string }): string[] {
  const paths = [
    path.join(resolveCodexHomePath(input.homePath), "config.toml"),
    ...parentDirsFromRoot(input.cwd).map((dir) => path.join(dir, ".codex", "config.toml")),
  ];
  const seen = new Set<string>();
  return paths.filter((configPath) => {
    const normalized = path.resolve(configPath);
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

function isOpenRouterBaseUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  try {
    return new URL(value).hostname === OPENROUTER_HOSTNAME;
  } catch {
    return false;
  }
}

function mergeModelProviders(
  target: Map<string, TomlTable>,
  providers: TomlTable | undefined,
): void {
  if (!providers) {
    return;
  }

  for (const [providerName, providerValue] of Object.entries(providers)) {
    const providerTable = readTomlTable(providerValue);
    if (!providerTable) {
      continue;
    }
    target.set(providerName, {
      ...(target.get(providerName) ?? {}),
      ...providerTable,
    });
  }
}

async function readConfigTable(configPath: string): Promise<TomlTable | null> {
  const raw = await readFile(configPath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return null;
  }
  return parseToml(raw) as TomlTable;
}

export async function discoverOpenRouterModelProviderNames(input: {
  readonly homePath?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<ReadonlyArray<string>> {
  const providers = new Map<string, TomlTable>();

  for (const configPath of codexConfigPaths(input)) {
    const config = await readConfigTable(configPath);
    mergeModelProviders(providers, readTomlTable(config?.model_providers));
  }

  const providerNames = [...providers.entries()]
    .filter(([, provider]) => isOpenRouterBaseUrl(provider.base_url))
    .map(([providerName]) => providerName);

  const openAiBaseUrl = input.env?.OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL;
  if (isOpenRouterBaseUrl(openAiBaseUrl)) {
    providerNames.push("openai");
  }

  return [...new Set(providerNames)].sort();
}

export function buildOpenRouterCacheConfigOverrides(
  providerNames: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return providerNames.map(
    (providerName) =>
      `model_providers.${providerName}.http_headers.${OPENROUTER_CACHE_HEADER}="${OPENROUTER_CACHE_VALUE}"`,
  );
}

export async function buildOpenRouterCacheConfigOverridesForCodex(input: {
  readonly homePath?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<ReadonlyArray<string>> {
  return buildOpenRouterCacheConfigOverrides(await discoverOpenRouterModelProviderNames(input));
}
