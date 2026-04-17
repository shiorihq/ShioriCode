import { readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type {
  EffectiveSkillEntry,
  EffectiveSkillRemoveInput,
  EffectiveSkillSource,
} from "contracts";

import type {
  ProviderMcpDescriptor,
  ProviderMcpToolExecutor,
  ProviderMcpToolRuntime,
} from "./mcpServers.ts";

const SKILL_FILE_NAME = "SKILL.md";
const MAX_SKILL_CONTENT_CHARS = 120_000;
const MAX_SKILL_PROMPT_DESCRIPTION_CHARS = 240;
const MAX_SKILL_PROMPT_ENTRIES = 120;

export interface ProviderSkillRuntime extends ProviderMcpToolRuntime {
  readonly skillPrompt: string | undefined;
}

export interface SkillDiscoveryResult {
  readonly skills: ReadonlyArray<EffectiveSkillEntry>;
  readonly warnings: ReadonlyArray<string>;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
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

function normalizeSkillName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  if (!content.startsWith("---")) {
    return {};
  }

  const closingIndex = content.indexOf("\n---", 3);
  if (closingIndex < 0) {
    return {};
  }

  const frontmatter = content.slice(3, closingIndex).trim();
  const parsed: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/g)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match || !match[1]) {
      continue;
    }
    const value = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
    if (value.length > 0) {
      parsed[match[1]] = value;
    }
  }

  return {
    ...(parsed.name ? { name: parsed.name } : {}),
    ...(parsed.description ? { description: parsed.description } : {}),
  };
}

function readFirstHeading(content: string): string | undefined {
  for (const line of content.split(/\r?\n/g)) {
    const match = line.match(/^#\s+(.+)$/);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }
  return undefined;
}

async function readSkillFile(input: {
  readonly provider: EffectiveSkillSource;
  readonly scope: "user" | "project";
  readonly directoryName: string;
  readonly filePath: string;
}): Promise<EffectiveSkillEntry> {
  const content = await readFile(input.filePath, "utf8");
  const frontmatter = parseSkillFrontmatter(content);
  const name = frontmatter.name ?? readFirstHeading(content) ?? input.directoryName;
  const description =
    frontmatter.description ??
    `Load the ${name} skill instructions from ${path.basename(path.dirname(input.filePath))}.`;

  return {
    name,
    description,
    path: input.filePath,
    source: input.provider,
    scope: input.scope,
    readOnly: true,
  };
}

async function discoverSkillsInDirectory(input: {
  readonly provider: EffectiveSkillSource;
  readonly scope: "user" | "project";
  readonly skillsDir: string;
}): Promise<SkillDiscoveryResult> {
  const warnings: string[] = [];
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await readdir(input.skillsDir, { withFileTypes: true });
  } catch {
    return { skills: [], warnings };
  }

  const skills: EffectiveSkillEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillPath = path.join(input.skillsDir, entry.name, SKILL_FILE_NAME);
    try {
      skills.push(
        await readSkillFile({
          provider: input.provider,
          scope: input.scope,
          directoryName: entry.name,
          filePath: skillPath,
        }),
      );
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      warnings.push(
        `Failed to load ${input.provider} skill from ${skillPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return { skills, warnings };
}

function providerUserSkillsDir(input: {
  readonly provider: EffectiveSkillSource;
  readonly codexHomePath?: string;
  readonly claudeHomePath?: string;
  readonly shioriHomePath?: string;
}): string {
  switch (input.provider) {
    case "codex":
      return path.join(input.codexHomePath?.trim() || path.join(homedir(), ".codex"), "skills");
    case "claude":
      return path.join(input.claudeHomePath?.trim() || path.join(homedir(), ".claude"), "skills");
    case "shiori":
      return path.join(input.shioriHomePath?.trim() || path.join(homedir(), ".agents"), "skills");
  }
}

function providerProjectSkillsDir(provider: EffectiveSkillSource, cwd: string): string {
  switch (provider) {
    case "codex":
      return path.join(cwd, ".codex", "skills");
    case "claude":
      return path.join(cwd, ".claude", "skills");
    case "shiori":
      return path.join(cwd, ".agents", "skills");
  }
}

function mergeSkills(skills: ReadonlyArray<EffectiveSkillEntry>): EffectiveSkillEntry[] {
  const merged = new Map<string, EffectiveSkillEntry>();
  for (const skill of skills) {
    merged.set(`${skill.source}:${normalizeSkillName(skill.name)}`, skill);
  }
  return [...merged.values()];
}

export async function discoverProviderSkills(input: {
  readonly provider: EffectiveSkillSource;
  readonly cwd?: string;
  readonly codexHomePath?: string;
  readonly claudeHomePath?: string;
  readonly shioriHomePath?: string;
}): Promise<SkillDiscoveryResult> {
  const locations = [
    {
      scope: "user" as const,
      skillsDir: providerUserSkillsDir(input),
    },
    ...parentDirs(input.cwd).map((dir) => ({
      scope: "project" as const,
      skillsDir: providerProjectSkillsDir(input.provider, dir),
    })),
  ];

  const results = await Promise.all(
    locations.map((location) =>
      discoverSkillsInDirectory({
        provider: input.provider,
        scope: location.scope,
        skillsDir: location.skillsDir,
      }),
    ),
  );

  return {
    skills: mergeSkills(results.flatMap((result) => result.skills)),
    warnings: results.flatMap((result) => result.warnings),
  };
}

export async function listEffectiveSkills(input: {
  readonly cwd?: string;
  readonly codexHomePath?: string;
  readonly claudeHomePath?: string;
  readonly shioriHomePath?: string;
}): Promise<SkillDiscoveryResult> {
  const [shiori, codex, claude] = await Promise.all([
    discoverProviderSkills({ provider: "shiori", ...input }),
    discoverProviderSkills({ provider: "codex", ...input }),
    discoverProviderSkills({ provider: "claude", ...input }),
  ]);

  return {
    skills: [...shiori.skills, ...codex.skills, ...claude.skills],
    warnings: [...shiori.warnings, ...codex.warnings, ...claude.warnings],
  };
}

function formatSkillPrompt(skills: ReadonlyArray<EffectiveSkillEntry>): string | undefined {
  if (skills.length === 0) {
    return undefined;
  }
  const lines = [
    "## Shiori Skills",
    "Shiori-native skills are provider-neutral skills discovered from `~/.agents/skills` and workspace `.agents/skills`.",
    "If a user request matches a skill description, call the `skill` tool with that skill name before acting.",
    "",
    "Available skills:",
    ...skills.slice(0, MAX_SKILL_PROMPT_ENTRIES).map((skill) => {
      const description = truncate(skill.description, MAX_SKILL_PROMPT_DESCRIPTION_CHARS);
      return `- \`${skill.name}\` (${skill.scope}): ${description}`;
    }),
  ];
  if (skills.length > MAX_SKILL_PROMPT_ENTRIES) {
    lines.push(`- ...and ${skills.length - MAX_SKILL_PROMPT_ENTRIES} more skills.`);
  }
  return lines.join("\n");
}

function resolveRequestedSkillName(input: Record<string, unknown>): string | null {
  for (const key of ["skill", "skillName", "skill_name", "name"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function skillLookupKeys(skill: EffectiveSkillEntry): string[] {
  const base = normalizeSkillName(skill.name);
  return [base, path.basename(path.dirname(skill.path)).toLowerCase()];
}

export async function buildShioriSkillToolRuntime(input: {
  readonly cwd?: string;
  readonly shioriHomePath?: string;
}): Promise<ProviderSkillRuntime> {
  const discovery = await discoverProviderSkills({
    provider: "shiori",
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.shioriHomePath ? { shioriHomePath: input.shioriHomePath } : {}),
  });
  const lookup = new Map<string, EffectiveSkillEntry>();
  for (const skill of discovery.skills) {
    for (const key of skillLookupKeys(skill)) {
      lookup.set(key, skill);
    }
  }

  const descriptors: ProviderMcpDescriptor[] =
    discovery.skills.length === 0
      ? []
      : [
          {
            name: "skill",
            title: "Load skill",
            description:
              "Load detailed instructions for an available Shiori skill before using it.",
            inputSchema: {
              type: "object",
              properties: {
                skill: {
                  type: "string",
                  enum: discovery.skills.map((skill) => skill.name),
                  description: "Skill name to load.",
                },
              },
              required: ["skill"],
              additionalProperties: false,
            },
          },
        ];
  const executors = new Map<string, ProviderMcpToolExecutor>();
  if (discovery.skills.length > 0) {
    executors.set("skill", {
      title: "Load skill",
      execute: async (toolInput) => {
        const requestedName = resolveRequestedSkillName(toolInput);
        if (!requestedName) {
          return {
            error: "Missing skill name.",
            availableSkills: discovery.skills.map((skill) => skill.name),
          };
        }
        const skill = lookup.get(normalizeSkillName(requestedName));
        if (!skill) {
          return {
            error: `Unknown skill '${requestedName}'.`,
            availableSkills: discovery.skills.map((entry) => entry.name),
          };
        }
        const content = await readFile(skill.path, "utf8");
        return {
          skill: skill.name,
          description: skill.description,
          path: skill.path,
          source: skill.source,
          scope: skill.scope,
          content: truncate(content, MAX_SKILL_CONTENT_CHARS),
          truncated: content.length > MAX_SKILL_CONTENT_CHARS,
        };
      },
    });
  }

  return {
    descriptors,
    executors,
    warnings: discovery.warnings,
    skillPrompt: formatSkillPrompt(discovery.skills),
    close: async () => undefined,
  };
}

export async function removeEffectiveSkill(input: EffectiveSkillRemoveInput): Promise<void> {
  if (path.basename(input.path) !== SKILL_FILE_NAME) {
    throw new Error(`Refusing to remove skill '${input.name}' because the path is not SKILL.md.`);
  }
  const skillDir = path.dirname(input.path);
  const parentDir = path.basename(path.dirname(skillDir));
  if (parentDir !== "skills") {
    throw new Error(
      `Refusing to remove skill '${input.name}' because it is not inside a skills directory.`,
    );
  }
  const skillStat = await stat(input.path);
  if (!skillStat.isFile()) {
    throw new Error(`Refusing to remove skill '${input.name}' because SKILL.md is not a file.`);
  }
  await rm(skillDir, { recursive: true, force: true });
}
