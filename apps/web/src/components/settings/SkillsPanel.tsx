import { useCallback, useState } from "react";
import {
  BlocksIcon,
  ExternalLinkIcon,
  GlobeIcon,
  InfoIcon,
  PlusIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";
import type { McpServerEntry, McpTransport, ProviderKind } from "contracts";
import { PROVIDER_DISPLAY_NAMES } from "contracts";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { ensureNativeApi } from "../../nativeApi";
import { openInPreferredEditor } from "../../editorPreferences";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
import { SettingsPageContainer, SettingsSection, SettingsRow } from "./SettingsPanels";

// ── MCP Server Card ──────────────────────────────────────────────

function TransportBadge({ transport }: { transport: McpTransport }) {
  const label = transport === "stdio" ? "stdio" : transport.toUpperCase();
  return (
    <Badge variant="secondary" className="text-[10px] font-mono uppercase">
      {label}
    </Badge>
  );
}

function ProviderChips({ providers }: { providers: readonly ProviderKind[] }) {
  if (providers.length === 0) {
    return <span className="text-[11px] text-muted-foreground">All providers</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {providers.map((p) => (
        <Badge key={p} variant="outline" className="text-[10px]">
          {PROVIDER_DISPLAY_NAMES[p]}
        </Badge>
      ))}
    </span>
  );
}

function McpServerCard({
  server,
  onToggle,
  onDelete,
}: {
  server: McpServerEntry;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const endpoint =
    server.transport === "stdio"
      ? [server.command, ...(server.args ?? [])].join(" ")
      : (server.url ?? "");

  return (
    <div className="flex items-center gap-3 border-t border-border px-4 py-3 first:border-t-0 sm:px-5">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{server.name}</span>
          <TransportBadge transport={server.transport} />
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground">{endpoint}</p>
        <ProviderChips providers={server.providers} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Switch checked={server.enabled} onCheckedChange={onToggle} />
        <Button size="icon-xs" variant="ghost" onClick={onDelete}>
          <Trash2Icon className="size-3.5 text-muted-foreground" />
        </Button>
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
          <div className="space-y-4 py-4">
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
        description="ShioriCode injects configured stdio MCP servers into an isolated Codex runtime home for each session. HTTP and SSE servers are not passed to Codex yet."
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

function ShioriInfoSection() {
  return (
    <SettingsSection title="Shiori" icon={<GlobeIcon className="size-3.5" />}>
      <SettingsRow
        title="ShioriCode-native MCP runtime"
        description="The Shiori provider connects directly to configured MCP servers in this app process, namespaces tools per server, and executes them locally during the turn."
      />
    </SettingsSection>
  );
}

// ── Main Panel ───────────────────────────────────────────────────

export function SkillsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const servers = settings.mcpServers?.servers ?? EMPTY_MCP_SERVERS;

  const persistServers = useCallback(
    (next: McpServerEntry[]) => {
      updateSettings({ mcpServers: { servers: next } });
    },
    [updateSettings],
  );

  const handleAdd = (entry: McpServerEntry) => {
    persistServers([...servers, entry]);
  };

  const handleToggle = (index: number) => {
    const next = servers.map((s, i) => (i === index ? { ...s, enabled: !s.enabled } : s));
    persistServers(next);
  };

  const handleDelete = (index: number) => {
    persistServers(servers.filter((_, i) => i !== index));
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="MCP Servers"
        icon={<BlocksIcon className="size-3.5" />}
        headerAction={<AddMcpServerDialog onAdd={handleAdd} />}
      >
        {servers.length === 0 ? (
          <Empty className="min-h-48">
            <EmptyMedia variant="icon">
              <BlocksIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No MCP servers configured</EmptyTitle>
              <EmptyDescription>
                Add MCP servers to extend your coding agents with additional tools and capabilities.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          servers.map((server, index) => (
            <McpServerCard
              key={[
                server.name,
                server.transport,
                server.transport === "stdio"
                  ? [server.command ?? "", ...(server.args ?? [])].join(" ")
                  : (server.url ?? ""),
                server.providers.join(","),
              ].join("|")}
              server={server}
              onToggle={() => handleToggle(index)}
              onDelete={() => handleDelete(index)}
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection title="How it works" icon={<InfoIcon className="size-3.5" />}>
        <SettingsRow
          title="Global server registry"
          description="MCP servers configured here are passed into provider runtimes at session start. Use provider filters per server to control delivery. Claude Agent and Shiori consume configured servers directly, while Codex currently supports stdio servers via managed runtime config."
        />
      </SettingsSection>

      <CodexInfoSection />
      <ShioriInfoSection />
    </SettingsPageContainer>
  );
}
