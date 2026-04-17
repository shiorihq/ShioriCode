import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildShioriSkillToolRuntime,
  discoverProviderSkills,
  listEffectiveSkills,
  removeEffectiveSkill,
} from "./skills.ts";

const TEMP_DIRS = new Set<string>();

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.add(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of TEMP_DIRS) {
    await rm(dir, { recursive: true, force: true });
  }
  TEMP_DIRS.clear();
});

async function writeSkill(root: string, relativeDir: string, content: string): Promise<string> {
  const dir = path.join(root, relativeDir);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "SKILL.md");
  await writeFile(filePath, content, "utf8");
  return filePath;
}

describe("discoverProviderSkills", () => {
  it("loads Shiori skills from ~/.agents/skills and workspace .agents/skills", async () => {
    const shioriHome = await createTempDir("shiori-skills-home-");
    const workspaceRoot = await createTempDir("shiori-skills-project-");
    await writeSkill(
      shioriHome,
      "skills/support",
      [
        "---",
        "name: support",
        "description: User-level support workflow.",
        "---",
        "# Support",
      ].join("\n"),
    );
    const projectSkillPath = await writeSkill(
      workspaceRoot,
      ".agents/skills/support",
      ["---", "name: support", "description: Project support workflow.", "---", "# Support"].join(
        "\n",
      ),
    );

    const result = await discoverProviderSkills({
      provider: "shiori",
      shioriHomePath: shioriHome,
      cwd: workspaceRoot,
    });

    expect(result.warnings).toEqual([]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      name: "support",
      description: "Project support workflow.",
      path: projectSkillPath,
      source: "shiori",
      scope: "project",
    });
  });

  it("lists Codex, Claude, and Shiori skills by provider standards", async () => {
    const shioriHome = await createTempDir("shiori-skills-home-");
    const codexHome = await createTempDir("codex-skills-home-");
    const claudeHome = await createTempDir("claude-skills-home-");
    await writeSkill(shioriHome, "skills/shiori-skill", "# Shiori Skill\n");
    await writeSkill(codexHome, "skills/codex-skill", "# Codex Skill\n");
    await writeSkill(claudeHome, "skills/claude-skill", "# Claude Skill\n");

    const result = await listEffectiveSkills({
      shioriHomePath: shioriHome,
      codexHomePath: codexHome,
      claudeHomePath: claudeHome,
    });

    expect(result.skills.map((skill) => `${skill.source}:${skill.name}`)).toEqual([
      "shiori:Shiori Skill",
      "codex:Codex Skill",
      "claude:Claude Skill",
    ]);
  });
});

describe("buildShioriSkillToolRuntime", () => {
  it("exposes a skill tool that loads SKILL.md content", async () => {
    const shioriHome = await createTempDir("shiori-skill-runtime-");
    const skillPath = await writeSkill(
      shioriHome,
      "skills/customer-support",
      [
        "---",
        "name: customer-support",
        "description: Support customers.",
        "---",
        "# Customer Support",
        "",
        "Use evidence first.",
      ].join("\n"),
    );

    const runtime = await buildShioriSkillToolRuntime({ shioriHomePath: shioriHome });
    assert.equal(runtime.descriptors[0]?.name, "skill");
    assert.match(runtime.skillPrompt ?? "", /customer-support/);

    const output = (await runtime.executors.get("skill")?.execute({ skill: "customer-support" })) as
      | Record<string, unknown>
      | undefined;

    assert.equal(output?.skill, "customer-support");
    assert.equal(output?.path, skillPath);
    assert.match(String(output?.content), /Use evidence first/);

    const stored = await readFile(skillPath, "utf8");
    assert.match(stored, /Customer Support/);
  });
});

describe("removeEffectiveSkill", () => {
  it("removes the selected skill directory", async () => {
    const shioriHome = await createTempDir("shiori-remove-skill-");
    const skillPath = await writeSkill(
      shioriHome,
      "skills/remove-me",
      ["---", "name: remove-me", "description: Temporary skill.", "---", "# Remove Me"].join("\n"),
    );

    await removeEffectiveSkill({
      source: "shiori",
      name: "remove-me",
      path: skillPath,
    });

    await expect(readFile(skillPath, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("refuses paths outside a skills directory", async () => {
    const root = await createTempDir("shiori-remove-skill-refuse-");
    const skillPath = path.join(root, "not-skills", "demo", "SKILL.md");
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, "# Demo\n", "utf8");

    await expect(
      removeEffectiveSkill({
        source: "shiori",
        name: "demo",
        path: skillPath,
      }),
    ).rejects.toThrow(/not inside a skills directory/);
  });
});
