import { insertRankedSearchResult, normalizeSearchQuery, scoreQueryMatch } from "./searchRanking";

export interface SkillReferenceCandidate {
  readonly name: string;
  readonly path: string;
  readonly enabled?: boolean;
  readonly description?: string;
  readonly displayName?: string;
  readonly shortDescription?: string;
  readonly scope?: string;
  readonly source?: string;
}

export interface SkillReferenceTrigger {
  readonly kind: "skill";
  readonly query: string;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly token: string;
}

function clampCursor(text: string, cursorInput: number): number {
  if (!Number.isFinite(cursorInput)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursorInput)));
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

function tokenStartForCursor(text: string, cursor: number): number {
  let index = cursor - 1;
  while (index >= 0 && !isWhitespace(text[index] ?? "")) {
    index -= 1;
  }
  return index + 1;
}

function basename(pathValue: string): string {
  const normalized = pathValue.replaceAll("\\", "/").replace(/\/+$/g, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function parentBasename(pathValue: string): string {
  const normalized = pathValue.replaceAll("\\", "/").replace(/\/+$/g, "");
  const parent = normalized.slice(0, normalized.lastIndexOf("/"));
  return basename(parent);
}

export function normalizeSkillReferenceName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

export function detectSkillReferenceTrigger(
  text: string,
  cursorInput: number,
): SkillReferenceTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const tokenStart = tokenStartForCursor(text, cursor);
  const token = text.slice(tokenStart, cursor);

  if (!token.startsWith("$")) {
    return null;
  }

  const query = token.slice(1);
  if (query.length > 0) {
    if (/^\d/.test(query)) {
      return null;
    }
    if (!/^[A-Za-z0-9:_-]*$/.test(query)) {
      return null;
    }
  }

  return {
    kind: "skill",
    query,
    rangeStart: tokenStart,
    rangeEnd: cursor,
    token,
  };
}

export function getSkillReferenceLabel(skill: SkillReferenceCandidate): string {
  return skill.displayName?.trim() || skill.name;
}

export function getSkillReferenceDescription(skill: SkillReferenceCandidate): string {
  return skill.shortDescription?.trim() || skill.description?.trim() || skill.path;
}

function scoreSkillReferenceCandidate(
  skill: SkillReferenceCandidate,
  normalizedQuery: string,
): number | null {
  const values = [
    { value: skill.name, base: 0 },
    { value: skill.displayName ?? "", base: 2 },
    { value: parentBasename(skill.path), base: 4 },
    { value: skill.shortDescription ?? "", base: 18 },
    { value: skill.description ?? "", base: 22 },
  ];
  const scores = values.flatMap(({ value, base }) => {
    const normalizedValue = normalizeSearchQuery(value);
    if (!normalizedValue) return [];
    const score = scoreQueryMatch({
      value: normalizedValue,
      query: normalizedQuery,
      exactBase: base,
      prefixBase: base + 2,
      boundaryBase: base + 4,
      includesBase: base + 8,
      fuzzyBase: base + 100,
      boundaryMarkers: ["-", "_", ":", "/", " "],
    });
    return score === null ? [] : [score];
  });

  return scores.length === 0 ? null : Math.min(...scores);
}

export function rankSkillReferenceCandidates(
  skills: ReadonlyArray<SkillReferenceCandidate>,
  query: string,
  limit = 40,
): SkillReferenceCandidate[] {
  const enabledSkills = skills.filter((skill) => skill.enabled !== false);
  const normalizedQuery = normalizeSearchQuery(query, { trimLeadingPattern: /^\$+/ });

  if (!normalizedQuery) {
    return enabledSkills.slice(0, limit);
  }

  const ranked: Array<{
    item: SkillReferenceCandidate;
    score: number;
    tieBreaker: string;
  }> = [];

  for (const skill of enabledSkills) {
    const score = scoreSkillReferenceCandidate(skill, normalizedQuery);
    if (score === null) {
      continue;
    }
    insertRankedSearchResult(
      ranked,
      {
        item: skill,
        score,
        tieBreaker: `${normalizeSkillReferenceName(skill.name)}\u0000${skill.path}`,
      },
      limit,
    );
  }

  return ranked.map((entry) => entry.item);
}

function escapeMarkdownLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function escapeMarkdownDestination(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(")", "\\)");
}

export function serializeSkillReference(skill: SkillReferenceCandidate): string {
  return `[$${escapeMarkdownLabel(skill.name)}](${escapeMarkdownDestination(skill.path)})`;
}

function buildExactSkillLookup(
  skills: ReadonlyArray<SkillReferenceCandidate>,
): Map<string, SkillReferenceCandidate> {
  const lookup = new Map<string, SkillReferenceCandidate>();
  const duplicates = new Set<string>();

  for (const skill of skills) {
    if (skill.enabled === false) {
      continue;
    }
    const keys = [
      normalizeSkillReferenceName(skill.name),
      normalizeSkillReferenceName(skill.displayName ?? ""),
      normalizeSkillReferenceName(parentBasename(skill.path)),
    ].filter(Boolean);
    for (const key of keys) {
      const existing = lookup.get(key);
      if (existing && existing.path !== skill.path) {
        duplicates.add(key);
        continue;
      }
      lookup.set(key, skill);
    }
  }

  for (const key of duplicates) {
    lookup.delete(key);
  }
  return lookup;
}

export function resolveBareSkillReferences(
  text: string,
  skills: ReadonlyArray<SkillReferenceCandidate>,
): string {
  if (!text.includes("$") || skills.length === 0) {
    return text;
  }

  const lookup = buildExactSkillLookup(skills);
  return text.replace(
    /(^|\s)\$([A-Za-z][A-Za-z0-9:_-]*)(?=$|\s|[.,;:!?])/g,
    (match, prefix, name) => {
      const skill = lookup.get(normalizeSkillReferenceName(name));
      if (!skill) {
        return match;
      }
      return `${prefix}${serializeSkillReference(skill)}`;
    },
  );
}
