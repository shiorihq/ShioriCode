import { useCallback, useMemo, useState } from "react";
import {
  IconGrid3Outline24 as BlocksIcon,
  IconChevronDownOutline24 as ChevronDownIcon,
  IconExternalLinkOutline24 as ExternalLinkIcon,
  IconTriangleWarningOutline24 as TriangleAlertIcon,
  IconPlusOutline24 as PlusIcon,
  IconMagnifierOutline24 as SearchIcon,
  IconConsoleOutline24 as TerminalIcon,
  IconTrash2Outline24 as Trash2Icon,
} from "nucleo-core-outline-24";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  EffectiveMcpServerEntry,
  EffectiveSkillEntry,
  McpServerEntry,
  McpTransport,
  ProviderKind,
} from "contracts";
import { PROVIDER_DISPLAY_NAMES } from "contracts";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { ensureNativeApi } from "../../nativeApi";
import { openInPreferredEditor } from "../../editorPreferences";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "../ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogPopup,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection, SettingsRow } from "./SettingsPanels";

// ── MCP Server Card ──────────────────────────────────────────────

const MCP_SERVERS_QUERY_KEY = ["settings", "mcpServers", "effective"] as const;
const SKILLS_QUERY_KEY = ["settings", "skills", "effective"] as const;

// ── Search Filter ───────────────────────────────────────────────

function SectionSearchFilter({
  value,
  onChange,
  placeholder,
  resultCount,
  totalCount,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  resultCount: number;
  totalCount: number;
}) {
  const isFiltering = value.length > 0;
  return (
    <div className="flex items-center gap-2 border-b border-border px-4 py-2 sm:px-5">
      <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
      />
      {isFiltering ? (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {resultCount} / {totalCount}
        </span>
      ) : null}
    </div>
  );
}

// ── Collapsible Source Group ────────────────────────────────────

function SourceGroup({
  source,
  count,
  defaultOpen,
  children,
}: {
  source: string;
  count: number;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 border-t border-border px-4 py-2.5 first:border-t-0 hover:bg-accent/40 sm:px-5">
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
            !open && "-rotate-90",
          )}
        />
        <span className="text-xs font-medium capitalize text-foreground">{source}</span>
        <Badge variant="secondary" className="text-[10px] tabular-nums">
          {count}
        </Badge>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div>{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

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

function serverIdentity(server: McpServerEntry): string {
  return [
    server.name,
    server.transport,
    server.transport === "stdio"
      ? [server.command ?? "", ...(server.args ?? [])].join(" ")
      : (server.url ?? ""),
    JSON.stringify(server.headers ?? {}),
    JSON.stringify(server.envHttpHeaders ?? {}),
    server.bearerTokenEnvVar ?? "",
    (server.oauthScopes ?? []).join(","),
    server.oauthResource ?? "",
    server.providers.join(","),
  ].join("|");
}

function displayServerName(server: EffectiveMcpServerEntry): string {
  return server.source === "shiori" ? server.name : server.name.replace(/^(codex|claude):/, "");
}

function effectiveServerIdentity(server: EffectiveMcpServerEntry): string {
  return [
    server.source,
    server.sourceName ?? "",
    server.configPath ?? "",
    serverIdentity(server),
  ].join("|");
}

function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === "authorization");
}

function canAuthenticateServer(server: EffectiveMcpServerEntry): boolean {
  return (
    server.transport !== "stdio" &&
    !hasAuthorizationHeader(server.headers) &&
    !hasAuthorizationHeader(server.envHttpHeaders) &&
    !server.bearerTokenEnvVar?.trim()
  );
}

function TransportBadge({ transport }: { transport: McpTransport }) {
  const label = transport === "stdio" ? "stdio" : transport.toUpperCase();
  return (
    <Badge variant="secondary" className="text-[10px] font-mono uppercase">
      {label}
    </Badge>
  );
}

function McpServerCard({
  server,
  onToggle,
  onDelete,
  onAuthenticate,
  authPending,
  grouped,
}: {
  server: EffectiveMcpServerEntry;
  onToggle?: () => void;
  onDelete?: () => void;
  onAuthenticate?: () => void;
  authPending?: boolean;
  grouped?: boolean;
}) {
  const endpoint =
    server.transport === "stdio"
      ? [server.command, ...(server.args ?? [])].join(" ")
      : (server.url ?? "");
  const authNeedsAttention = server.auth.status === "unauthenticated";
  const authMessage = server.auth.message ?? "Authentication required";
  const authLabel = server.auth.status === "authenticated" ? "Authenticated" : null;
  const showAuthAction = authNeedsAttention && typeof onAuthenticate === "function";

  return (
    <div
      className={cn(
        "flex items-center gap-3 border-t border-border/60 px-4 py-2.5 sm:px-5",
        grouped && "pl-10 sm:pl-11",
      )}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{displayServerName(server)}</span>
          {authNeedsAttention ? (
            <span title={authMessage}>
              <TriangleAlertIcon
                className="size-3.5 shrink-0 text-amber-600"
                aria-label={authMessage}
              />
            </span>
          ) : null}
          <TransportBadge transport={server.transport} />
        </div>
        <p className="truncate font-mono text-[11px] text-muted-foreground">{endpoint}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {showAuthAction ? (
          <Button
            size="xs"
            variant="link"
            className="h-auto px-0 text-amber-700 hover:text-amber-800"
            disabled={authPending}
            onClick={onAuthenticate}
            title={authMessage}
          >
            {authPending ? "Authenticating…" : "Authenticate"}
          </Button>
        ) : authLabel ? (
          <span className="text-xs text-muted-foreground">{authLabel}</span>
        ) : null}
        <Switch checked={server.enabled} disabled={server.readOnly} onCheckedChange={onToggle} />
        {onDelete ? (
          <Button size="icon-xs" variant="ghost" onClick={onDelete}>
            <Trash2Icon className="size-3.5 text-muted-foreground" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ── Add MCP Server Dialog ────────────────────────────────────────

const TRANSPORT_OPTIONS: { value: McpTransport; label: string }[] = [
  { value: "stdio", label: "stdio" },
  { value: "sse", label: "SSE" },
  { value: "http", label: "HTTP" },
];

const PROVIDER_OPTIONS: { value: ProviderKind; label: string }[] = [
  { value: "claudeAgent", label: PROVIDER_DISPLAY_NAMES.claudeAgent },
  { value: "codex", label: PROVIDER_DISPLAY_NAMES.codex },
  { value: "shiori", label: PROVIDER_DISPLAY_NAMES.shiori },
];
const EMPTY_MCP_SERVERS: readonly McpServerEntry[] = [];

function AddMcpServerDialog({ onAdd }: { onAdd: (entry: McpServerEntry) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [selectedProviders, setSelectedProviders] = useState<ProviderKind[]>([]);

  const resetForm = () => {
    setName("");
    setTransport("stdio");
    setUrl("");
    setCommand("");
    setArgs("");
    setSelectedProviders([]);
  };

  const isValid =
    name.trim().length > 0 &&
    (transport === "stdio" ? command.trim().length > 0 : url.trim().length > 0);

  const handleSubmit = () => {
    if (!isValid) return;
    const entry: McpServerEntry = {
      name: name.trim(),
      transport,
      enabled: true,
      providers: selectedProviders,
      ...(transport === "stdio"
        ? {
            command: command.trim(),
            ...(args.trim() ? { args: args.trim().split(/\s+/) } : {}),
          }
        : {
            url: url.trim(),
          }),
    };
    onAdd(entry);
    resetForm();
    setOpen(false);
  };

  const toggleProvider = (provider: ProviderKind) => {
    setSelectedProviders((prev) =>
      prev.includes(provider) ? prev.filter((p) => p !== provider) : [...prev, provider],
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm" variant="outline" className="gap-1.5">
            <PlusIcon className="size-3.5" />
            Add Server
          </Button>
        }
      />
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add MCP Server</DialogTitle>
          <DialogDescription>
            Configure an MCP server to extend your coding agent with additional tools.
          </DialogDescription>
        </DialogHeader>

        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          <div className="space-y-4 px-6 py-4">
            {/* Name */}
            <div className="space-y-1.5">
              <label htmlFor="mcp-server-name" className="text-sm font-medium">
                Name <span className="text-destructive">*</span>
              </label>
              <Input
                id="mcp-server-name"
                required
                autoComplete="off"
                placeholder="e.g. GitHub, Filesystem"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            {/* Transport */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Transport</label>
              <Select value={transport} onValueChange={(v) => setTransport(v as McpTransport)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {TRANSPORT_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>

            {/* Transport-specific fields */}
            {transport === "stdio" ? (
              <>
                <div className="space-y-1.5">
                  <label htmlFor="mcp-server-command" className="text-sm font-medium">
                    Command <span className="text-destructive">*</span>
                  </label>
                  <Input
                    id="mcp-server-command"
                    required
                    autoComplete="off"
                    placeholder="e.g. npx, node, python"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    className="font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="mcp-server-args" className="text-sm font-medium">
                    Arguments <span className="text-muted-foreground">(optional)</span>
                  </label>
                  <Input
                    id="mcp-server-args"
                    autoComplete="off"
                    placeholder="e.g. -y @modelcontextprotocol/server-github"
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                    className="font-mono"
                  />
                </div>
              </>
            ) : (
              <div className="space-y-1.5">
                <label htmlFor="mcp-server-url" className="text-sm font-medium">
                  URL <span className="text-destructive">*</span>
                </label>
                <Input
                  id="mcp-server-url"
                  required
                  autoComplete="url"
                  placeholder="https://mcp.example.com/sse"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="font-mono"
                />
              </div>
            )}

            {/* Provider affinity */}
            <div className="space-y-2">
              <div className="text-sm font-medium">
                Providers <span className="font-normal text-muted-foreground">(none = all)</span>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:gap-x-8 sm:gap-y-2">
                {PROVIDER_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    className="flex cursor-pointer items-center gap-2.5 text-sm"
                  >
                    <Checkbox
                      checked={selectedProviders.includes(opt.value)}
                      onCheckedChange={() => toggleProvider(opt.value)}
                    />
                    <span className="select-none">{opt.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <DialogClose
              render={
                <Button variant="outline" type="button">
                  Cancel
                </Button>
              }
            />
            <Button type="submit" disabled={!isValid}>
              Add Server
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

// ── Provider Info Sections ───────────────────────────────────────

function CodexInfoSection() {
  const handleOpenConfig = useCallback(() => {
    const codexHome = process.env.CODEX_HOME ?? `${process.env.HOME ?? "~"}/.codex`;
    void openInPreferredEditor(ensureNativeApi(), `${codexHome}/config.toml`).catch(() => {
      // ignore if no editor available
    });
  }, []);

  return (
    <SettingsSection title="Codex" icon={<TerminalIcon className="size-3.5" />}>
      <SettingsRow
        title="Managed MCP at session start"
        description="ShioriCode injects configured MCP servers into an isolated Codex runtime home for each session, while Codex continues to load its own user and project config."
        control={
          <Button size="sm" variant="outline" className="gap-1.5" onClick={handleOpenConfig}>
            <ExternalLinkIcon className="size-3" />
            Open global config.toml
          </Button>
        }
      />
    </SettingsSection>
  );
}

function ClaudeInfoSection() {
  const handleOpenConfig = useCallback(() => {
    const home = process.env.HOME ?? "~";
    void openInPreferredEditor(ensureNativeApi(), `${home}/.claude/settings.json`).catch(() => {
      // ignore if no editor available
    });
  }, []);

  return (
    <SettingsSection title="Claude" icon={<TerminalIcon className="size-3.5" />}>
      <SettingsRow
        title="Filesystem settings"
        description="ShioriCode lets Claude load user and project MCP configuration from Claude settings sources."
        control={
          <Button size="sm" variant="outline" className="gap-1.5" onClick={handleOpenConfig}>
            <ExternalLinkIcon className="size-3" />
            Open settings.json
          </Button>
        }
      />
    </SettingsSection>
  );
}

// ── Grouping helpers ────────────────────────────────────────────

const SOURCE_ORDER: readonly string[] = ["shiori", "codex", "claude"];

function groupBySource<T extends { source: string }>(items: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const existing = groups.get(item.source);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(item.source, [item]);
    }
  }
  // Sort groups by canonical source order
  const sorted = new Map<string, T[]>();
  for (const source of SOURCE_ORDER) {
    const group = groups.get(source);
    if (group) sorted.set(source, group);
  }
  // Append any remaining sources not in the canonical order
  for (const [source, group] of groups) {
    if (!sorted.has(source)) sorted.set(source, group);
  }
  return sorted;
}

function matchesSearch(query: string, ...fields: (string | undefined)[]): boolean {
  const q = query.toLowerCase();
  return fields.some((f) => f?.toLowerCase().includes(q));
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
    <SettingsSection title="Skills" icon={<BlocksIcon className="size-3.5" />}>
      {skills.length === 0 ? (
        <Empty className="min-h-36">
          <EmptyMedia variant="icon">
            <BlocksIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>No skills found</EmptyTitle>
            <EmptyDescription>
              Add Shiori skills under ~/.agents/skills or workspace .agents/skills.
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

// ── Grouped MCP Servers Section ─────────────────────────────────

function McpServersSection({
  servers,
  displayedServers,
  warnings,
  isLoading,
  authenticatingServerKey,
  onAdd,
  onAuthenticate,
  onToggle,
  onDelete,
  onDeleteExternal,
}: {
  servers: readonly McpServerEntry[];
  displayedServers: readonly EffectiveMcpServerEntry[];
  warnings: readonly string[];
  isLoading: boolean;
  authenticatingServerKey: string | null;
  onAdd: (entry: McpServerEntry) => void;
  onAuthenticate: (server: EffectiveMcpServerEntry) => void;
  onToggle: (index: number) => void;
  onDelete: (index: number) => void;
  onDeleteExternal: (server: EffectiveMcpServerEntry) => void;
}) {
  const [search, setSearch] = useState("");

  const resolvePersistedServerIndex = useCallback(
    (server: EffectiveMcpServerEntry) => {
      if (server.readOnly) return -1;
      const identity = serverIdentity(server);
      return servers.findIndex((entry) => serverIdentity(entry) === identity);
    },
    [servers],
  );

  const filtered = useMemo(() => {
    if (!search) return displayedServers;
    return displayedServers.filter((s) =>
      matchesSearch(search, s.name, s.source, s.transport, s.url, s.command),
    );
  }, [displayedServers, search]);

  const grouped = useMemo(() => groupBySource(filtered), [filtered]);

  const showSearch = displayedServers.length > 5;
  const multipleGroups = grouped.size > 1;

  const renderServerCard = (server: EffectiveMcpServerEntry, grouped: boolean) => {
    const persistedIndex = resolvePersistedServerIndex(server);
    return (
      <McpServerCard
        key={`${server.source}|${serverIdentity(server)}`}
        server={server}
        grouped={grouped}
        authPending={authenticatingServerKey === effectiveServerIdentity(server)}
        {...(canAuthenticateServer(server)
          ? {
              onAuthenticate: () => onAuthenticate(server),
            }
          : {})}
        {...(persistedIndex >= 0
          ? {
              onToggle: () => onToggle(persistedIndex),
              onDelete: () => onDelete(persistedIndex),
            }
          : {
              onDelete: () => onDeleteExternal(server),
            })}
      />
    );
  };

  return (
    <SettingsSection
      title="MCP Servers"
      icon={<BlocksIcon className="size-3.5" />}
      headerAction={<AddMcpServerDialog onAdd={onAdd} />}
    >
      {warnings.length > 0 ? (
        <div className="px-4 pb-0 pt-4 sm:px-5">
          <Alert variant="warning" className="rounded-2xl">
            <TriangleAlertIcon />
            <AlertTitle>MCP needs attention</AlertTitle>
            <AlertDescription>
              {warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      {displayedServers.length === 0 ? (
        <Empty className="min-h-48">
          <EmptyMedia variant="icon">
            <BlocksIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>
              {isLoading ? "Loading MCP servers" : "No MCP servers configured"}
            </EmptyTitle>
            <EmptyDescription>
              {isLoading
                ? "Checking ShioriCode, Codex, and Claude MCP configuration."
                : "Add MCP servers to extend your coding agents with additional tools and capabilities."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {showSearch ? (
            <SectionSearchFilter
              value={search}
              onChange={setSearch}
              placeholder="Filter MCP servers…"
              resultCount={filtered.length}
              totalCount={displayedServers.length}
            />
          ) : null}
          <div className="max-h-96 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground sm:px-5">
                No servers match &ldquo;{search}&rdquo;
              </p>
            ) : multipleGroups ? (
              Array.from(grouped.entries()).map(([source, items]) => (
                <SourceGroup key={source} source={source} count={items.length} defaultOpen>
                  {items.map((server) => renderServerCard(server, true))}
                </SourceGroup>
              ))
            ) : (
              filtered.map((server) => renderServerCard(server, false))
            )}
          </div>
        </>
      )}
    </SettingsSection>
  );
}

// ── Main Panel ───────────────────────────────────────────────────

export function SkillsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const queryClient = useQueryClient();
  const [authenticatingServerKey, setAuthenticatingServerKey] = useState<string | null>(null);
  const servers = settings.mcpServers?.servers ?? EMPTY_MCP_SERVERS;
  const skillsQuery = useQuery({
    queryKey: SKILLS_QUERY_KEY,
    queryFn: () => ensureNativeApi().server.listSkills(),
    staleTime: 5_000,
  });
  const effectiveServersQuery = useQuery({
    queryKey: MCP_SERVERS_QUERY_KEY,
    queryFn: () => ensureNativeApi().server.listMcpServers(),
    staleTime: 5_000,
  });
  const fallbackServers: EffectiveMcpServerEntry[] = servers.map((server) => ({
    ...server,
    source: "shiori",
    readOnly: false,
    auth: { status: "unknown" },
  }));
  const displayedServers = effectiveServersQuery.data?.servers ?? fallbackServers;
  const effectiveWarnings = effectiveServersQuery.data?.warnings ?? [];

  const persistServers = useCallback(
    (next: McpServerEntry[]) => {
      updateSettings({ mcpServers: { servers: next } });
      void queryClient.invalidateQueries({ queryKey: MCP_SERVERS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY });
    },
    [queryClient, updateSettings],
  );

  const handleAdd = useCallback(
    (entry: McpServerEntry) => {
      persistServers([...servers, entry]);
    },
    [persistServers, servers],
  );

  const handleToggle = useCallback(
    (index: number) => {
      const next = servers.map((s, i) => (i === index ? { ...s, enabled: !s.enabled } : s));
      persistServers(next);
    },
    [persistServers, servers],
  );

  const handleDelete = useCallback(
    (index: number) => {
      persistServers(servers.filter((_, i) => i !== index));
    },
    [persistServers, servers],
  );

  const handleDeleteExternalServer = useCallback(
    (server: EffectiveMcpServerEntry) => {
      void ensureNativeApi()
        .server.removeMcpServer({
          source: server.source,
          name: server.name,
          ...(server.sourceName ? { sourceName: server.sourceName } : {}),
          ...(server.configPath ? { configPath: server.configPath } : {}),
        })
        .then(() => queryClient.invalidateQueries({ queryKey: MCP_SERVERS_QUERY_KEY }));
    },
    [queryClient],
  );

  const handleAuthenticateServer = useCallback(
    async (server: EffectiveMcpServerEntry) => {
      const key = effectiveServerIdentity(server);
      setAuthenticatingServerKey(key);
      try {
        await ensureNativeApi().server.authenticateMcpServer({
          source: server.source,
          name: server.name,
          ...(server.sourceName ? { sourceName: server.sourceName } : {}),
          ...(server.configPath ? { configPath: server.configPath } : {}),
        });
        toastManager.add({
          type: "success",
          title: `Authenticated ${displayServerName(server)}`,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: error instanceof Error ? error.message : "Failed to authenticate MCP server.",
        });
      } finally {
        setAuthenticatingServerKey((current) => (current === key ? null : current));
        void queryClient.invalidateQueries({ queryKey: MCP_SERVERS_QUERY_KEY });
      }
    },
    [queryClient],
  );

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
        <SettingsSection title="Skills" icon={<BlocksIcon className="size-3.5" />}>
          <Empty className="min-h-36">
            <EmptyMedia variant="icon">
              <BlocksIcon />
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

      <McpServersSection
        servers={servers}
        displayedServers={displayedServers}
        warnings={effectiveWarnings}
        isLoading={effectiveServersQuery.isLoading}
        authenticatingServerKey={authenticatingServerKey}
        onAdd={handleAdd}
        onAuthenticate={handleAuthenticateServer}
        onToggle={handleToggle}
        onDelete={handleDelete}
        onDeleteExternal={handleDeleteExternalServer}
      />

      <CodexInfoSection />
      <ClaudeInfoSection />
    </SettingsPageContainer>
  );
}
