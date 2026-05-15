import type { McpServerEntry } from "contracts";

export type MarketplaceConnectorCategory =
  | "Developer"
  | "Browser"
  | "Files"
  | "Knowledge"
  | "Payments"
  | "Reasoning";

export type MarketplaceConnector = {
  id: string;
  name: string;
  category: MarketplaceConnectorCategory;
  summary: string;
  commandPreview: string;
  docsUrl?: string;
  requiredEnvironment?: readonly string[];
  server: Omit<McpServerEntry, "name" | "enabled">;
};

export const MARKETPLACE_SERVER_NAME_PREFIX = "marketplace-";

export const MARKETPLACE_CONNECTORS = [
  {
    id: "github",
    name: "GitHub",
    category: "Developer",
    summary: "Repository, issue, pull request, and code search tools for agent sessions.",
    commandPreview: "npx -y @modelcontextprotocol/server-github",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    requiredEnvironment: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      providers: [],
    },
  },
  {
    id: "filesystem",
    name: "Filesystem",
    category: "Files",
    summary: "Read and write files in the current workspace through an MCP server.",
    commandPreview: "npx -y @modelcontextprotocol/server-filesystem .",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    requiredEnvironment: [],
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
      providers: [],
    },
  },
  {
    id: "context7",
    name: "Context7",
    category: "Knowledge",
    summary: "Fetch current library documentation and code examples during implementation.",
    commandPreview: "npx -y @upstash/context7-mcp",
    docsUrl: "https://github.com/upstash/context7",
    requiredEnvironment: [],
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      providers: [],
    },
  },
  {
    id: "playwright",
    name: "Playwright",
    category: "Browser",
    summary: "Browser automation tools for inspecting, testing, and debugging local web apps.",
    commandPreview: "npx -y @playwright/mcp@latest",
    docsUrl: "https://github.com/microsoft/playwright-mcp",
    requiredEnvironment: [],
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
      providers: [],
    },
  },
  {
    id: "stripe",
    name: "Stripe",
    category: "Payments",
    summary: "Inspect Stripe resources and documentation through Stripe's hosted OAuth MCP.",
    commandPreview: "https://mcp.stripe.com",
    docsUrl: "https://docs.stripe.com/mcp",
    requiredEnvironment: [],
    server: {
      transport: "http",
      url: "https://mcp.stripe.com",
      oauthResource: "https://mcp.stripe.com",
      providers: [],
    },
  },
  {
    id: "notion",
    name: "Notion",
    category: "Knowledge",
    summary: "Search and update Notion workspace content through Notion's hosted OAuth MCP.",
    commandPreview: "https://mcp.notion.com",
    docsUrl: "https://developers.notion.com/guides/mcp/mcp",
    requiredEnvironment: [],
    server: {
      transport: "http",
      url: "https://mcp.notion.com",
      oauthResource: "https://mcp.notion.com",
      providers: [],
    },
  },
  {
    id: "vercel",
    name: "Vercel",
    category: "Developer",
    summary: "Manage Vercel projects, deployments, logs, and docs through hosted OAuth MCP.",
    commandPreview: "https://mcp.vercel.com",
    docsUrl: "https://vercel.com/docs/agent-resources/vercel-mcp",
    requiredEnvironment: [],
    server: {
      transport: "http",
      url: "https://mcp.vercel.com",
      oauthResource: "https://mcp.vercel.com",
      providers: [],
    },
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    category: "Reasoning",
    summary: "Structured scratchpad tools for planning, decomposition, and revision.",
    commandPreview: "npx -y @modelcontextprotocol/server-sequential-thinking",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    requiredEnvironment: [],
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
      providers: [],
    },
  },
] as const satisfies readonly MarketplaceConnector[];

export type MarketplaceConnectorId = (typeof MARKETPLACE_CONNECTORS)[number]["id"];

export function getMarketplaceServerName(id: string): string {
  return `${MARKETPLACE_SERVER_NAME_PREFIX}${id}`;
}

export function isMarketplaceServer(server: Pick<McpServerEntry, "name">): boolean {
  return server.name.startsWith(MARKETPLACE_SERVER_NAME_PREFIX);
}

export function getMarketplaceConnector(id: string): MarketplaceConnector | undefined {
  return MARKETPLACE_CONNECTORS.find((connector) => connector.id === id);
}

export function getInstalledMarketplaceServer(
  servers: readonly McpServerEntry[],
  connectorId: string,
): McpServerEntry | undefined {
  const name = getMarketplaceServerName(connectorId);
  return servers.find((server) => server.name === name);
}

export function createMarketplaceServer(connector: MarketplaceConnector): McpServerEntry {
  return {
    ...connector.server,
    name: getMarketplaceServerName(connector.id),
    enabled: true,
  };
}

export function installMarketplaceConnector(
  servers: readonly McpServerEntry[],
  connectorId: string,
): McpServerEntry[] {
  const connector = getMarketplaceConnector(connectorId);
  if (!connector) return [...servers];

  const nextServer = createMarketplaceServer(connector);
  const existingIndex = servers.findIndex((server) => server.name === nextServer.name);
  if (existingIndex < 0) return [...servers, nextServer];

  return servers.map((server, index) =>
    index === existingIndex
      ? {
          ...nextServer,
          enabled: server.enabled,
        }
      : server,
  );
}

export function setMarketplaceConnectorEnabled(
  servers: readonly McpServerEntry[],
  connectorId: string,
  enabled: boolean,
): McpServerEntry[] {
  const name = getMarketplaceServerName(connectorId);
  return servers.map((server) => (server.name === name ? { ...server, enabled } : server));
}

export function uninstallMarketplaceConnector(
  servers: readonly McpServerEntry[],
  connectorId: string,
): McpServerEntry[] {
  const name = getMarketplaceServerName(connectorId);
  return servers.filter((server) => server.name !== name);
}
