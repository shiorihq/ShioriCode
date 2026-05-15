import { describe, expect, it } from "vitest";
import type { McpServerEntry } from "contracts";
import {
  MARKETPLACE_CONNECTORS,
  getInstalledMarketplaceServer,
  getMarketplaceServerName,
  installMarketplaceConnector,
  setMarketplaceConnectorEnabled,
  uninstallMarketplaceConnector,
} from "./connectorMarketplace";

describe("connector marketplace", () => {
  it("defines unique connector server names", () => {
    const names = MARKETPLACE_CONNECTORS.map((connector) => getMarketplaceServerName(connector.id));
    expect(new Set(names).size).toBe(names.length);
  });

  it("installs a connector as a Shiori MCP server entry", () => {
    const servers = installMarketplaceConnector([], "github");
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      name: "marketplace-github",
      transport: "stdio",
      command: "npx",
      enabled: true,
    });
  });

  it("installs hosted OAuth connectors as remote MCP server entries", () => {
    const servers = installMarketplaceConnector([], "vercel");
    expect(servers[0]).toMatchObject({
      name: "marketplace-vercel",
      transport: "http",
      url: "https://mcp.vercel.com",
      oauthResource: "https://mcp.vercel.com",
      enabled: true,
    });
  });

  it("updates marketplace templates without overwriting enabled state", () => {
    const existing: McpServerEntry[] = [
      {
        name: "marketplace-github",
        transport: "stdio",
        command: "old-command",
        enabled: false,
        providers: ["codex"],
      },
    ];

    const servers = installMarketplaceConnector(existing, "github");
    expect(servers).toHaveLength(1);
    expect(servers[0]?.command).toBe("npx");
    expect(servers[0]?.enabled).toBe(false);
  });

  it("toggles and uninstalls only the selected marketplace connector", () => {
    const customServer: McpServerEntry = {
      name: "custom",
      transport: "http",
      url: "https://example.com/mcp",
      enabled: true,
      providers: [],
    };
    const installed = installMarketplaceConnector([customServer], "context7");
    const disabled = setMarketplaceConnectorEnabled(installed, "context7", false);

    expect(getInstalledMarketplaceServer(disabled, "context7")?.enabled).toBe(false);
    expect(uninstallMarketplaceConnector(disabled, "context7")).toEqual([customServer]);
  });
});
