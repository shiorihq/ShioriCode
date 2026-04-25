import { describe, expect, it } from "vitest";

import {
  detectSkillReferenceTrigger,
  rankSkillReferenceCandidates,
  resolveBareSkillReferences,
  serializeSkillReference,
} from "./skillReferences";

const skills = [
  {
    name: "frontend-design",
    displayName: "Frontend Design",
    shortDescription: "Design and build polished frontend interfaces.",
    path: "/Users/test/.codex/skills/frontend-design/SKILL.md",
    enabled: true,
  },
  {
    name: "build-ios-apps:swiftui-ui-patterns",
    shortDescription: "SwiftUI UI guidance.",
    path: "/Users/test/.codex/plugins/build-ios-apps/skills/swiftui-ui-patterns/SKILL.md",
    enabled: true,
  },
  {
    name: "disabled",
    path: "/Users/test/.codex/skills/disabled/SKILL.md",
    enabled: false,
  },
];

describe("skillReferences", () => {
  it("detects a dollar skill trigger at the cursor", () => {
    expect(detectSkillReferenceTrigger("Use $front", 10)).toEqual({
      kind: "skill",
      query: "front",
      rangeStart: 4,
      rangeEnd: 10,
      token: "$front",
    });
  });

  it("does not treat currency-like tokens as skill triggers", () => {
    expect(detectSkillReferenceTrigger("Price is $10", "Price is $10".length)).toBeNull();
  });

  it("ranks enabled skills by name and description", () => {
    expect(rankSkillReferenceCandidates(skills, "swift").map((skill) => skill.name)).toEqual([
      "build-ios-apps:swiftui-ui-patterns",
    ]);
  });

  it("serializes selected skills as Codex-style markdown links", () => {
    expect(serializeSkillReference(skills[0]!)).toBe(
      "[$frontend-design](/Users/test/.codex/skills/frontend-design/SKILL.md)",
    );
  });

  it("rewrites unambiguous bare skill tokens before submit", () => {
    expect(resolveBareSkillReferences("Use $frontend-design please", skills)).toBe(
      "Use [$frontend-design](/Users/test/.codex/skills/frontend-design/SKILL.md) please",
    );
  });
});
