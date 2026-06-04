import { useCallback, useMemo, useState } from "react";
import {
  IconSparkleOutline24 as SkillsIcon,
  IconTrash2Outline24 as Trash2Icon,
} from "nucleo-core-outline-24";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { EffectiveSkillEntry } from "contracts";

import { ensureNativeApi } from "../../nativeApi";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SettingsPageContainer, SettingsSection } from "./SettingsPanels";
import {
  SKILLS_QUERY_KEY,
  SectionSearchFilter,
  SourceGroup,
  groupBySource,
  matchesSearch,
} from "./skillsMcpShared";

// ── Skill Card ─────────────────────────────────────────────────

function SkillCard({ skill, onDelete }: { skill: EffectiveSkillEntry; onDelete: () => void }) {
  return (
    <div className="flex items-center gap-3 border-t border-border/60 px-4 py-2.5 pl-10 sm:px-5 sm:pl-11">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{skill.name}</span>
          <Badge variant="outline" className="text-[10px] capitalize">
            {skill.scope}
          </Badge>
        </div>
        {skill.description ? (
          <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{skill.description}</p>
        ) : null}
      </div>
      <Button size="icon-xs" variant="ghost" onClick={onDelete}>
        <Trash2Icon className="size-3.5 text-muted-foreground" />
      </Button>
    </div>
  );
}

// ── Grouped Skills Section ──────────────────────────────────────

function SkillsSection({
  skills,
  onDelete,
}: {
  skills: readonly EffectiveSkillEntry[];
  onDelete: (skill: EffectiveSkillEntry) => void;
}) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search) return skills;
    return skills.filter((s) => matchesSearch(search, s.name, s.description, s.source, s.scope));
  }, [skills, search]);

  const grouped = useMemo(() => groupBySource(filtered), [filtered]);

  const showSearch = skills.length > 5;
  const multipleGroups = grouped.size > 1;

  return (
    <SettingsSection title="Skills" icon={<SkillsIcon className="size-3.5" />}>
      {skills.length === 0 ? (
        <Empty className="min-h-36">
          <EmptyMedia variant="icon">
            <SkillsIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>No skills found</EmptyTitle>
            <EmptyDescription>
              Add skills under ~/.agents/skills or workspace .agents/skills.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {showSearch ? (
            <SectionSearchFilter
              value={search}
              onChange={setSearch}
              placeholder="Filter skills…"
              resultCount={filtered.length}
              totalCount={skills.length}
            />
          ) : null}
          <div className="max-h-96 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground sm:px-5">
                No skills match &ldquo;{search}&rdquo;
              </p>
            ) : multipleGroups ? (
              Array.from(grouped.entries()).map(([source, items]) => (
                <SourceGroup key={source} source={source} count={items.length} defaultOpen>
                  {items.map((skill) => (
                    <SkillCard
                      key={`${skill.scope}|${skill.path}`}
                      skill={skill}
                      onDelete={() => onDelete(skill)}
                    />
                  ))}
                </SourceGroup>
              ))
            ) : (
              filtered.map((skill) => (
                <SkillCard
                  key={`${skill.source}|${skill.scope}|${skill.path}`}
                  skill={skill}
                  onDelete={() => onDelete(skill)}
                />
              ))
            )}
          </div>
        </>
      )}
    </SettingsSection>
  );
}

// ── Main Panel ───────────────────────────────────────────────────

export function SkillsPanel() {
  const queryClient = useQueryClient();
  const skillsQuery = useQuery({
    queryKey: SKILLS_QUERY_KEY,
    queryFn: () => ensureNativeApi().server.listSkills(),
    staleTime: 5_000,
  });

  const handleDeleteSkill = useCallback(
    (skill: EffectiveSkillEntry) => {
      void ensureNativeApi()
        .server.removeSkill({
          source: skill.source,
          name: skill.name,
          path: skill.path,
        })
        .then(() => queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY }));
    },
    [queryClient],
  );

  return (
    <SettingsPageContainer>
      {skillsQuery.isLoading ? (
        <SettingsSection title="Skills" icon={<SkillsIcon className="size-3.5" />}>
          <Empty className="min-h-36">
            <EmptyMedia variant="icon">
              <SkillsIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>Loading skills</EmptyTitle>
              <EmptyDescription>
                Checking ShioriCode, Codex, and Claude skill locations.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </SettingsSection>
      ) : (
        <SkillsSection skills={skillsQuery.data?.skills ?? []} onDelete={handleDeleteSkill} />
      )}
    </SettingsPageContainer>
  );
}
