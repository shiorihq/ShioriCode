import { describe, expect, it } from "vitest";

import { renderFrpcConfig, resolveFrpAsset } from "./frpcConnector";

describe("frpcConnector", () => {
  it("pins supported release assets to their published checksums", () => {
    expect(resolveFrpAsset("darwin", "arm64").sha256).toBe(
      "07663f5fa71330f074b25e32cc8bc4ae5ed40d9c2ee1690cbd981774475997a2",
    );
    expect(() => resolveFrpAsset("linux", "arm64")).toThrow(/not available/i);
  });

  it("renders an outbound TLS proxy with relay identity metadata", () => {
    const config = renderFrpcConfig({
      localPort: 3773,
      credential: {
        environmentRecordId: "record",
        environmentId: "env_12345678",
        endpoint: "https://sc-example.link.shiori.codes",
        serverAddr: "relay.link.shiori.codes",
        serverPort: 7443,
        serverTls: true,
        token: "connector-token",
        updatedAt: new Date(0).toISOString(),
      },
    });
    expect(config).toContain('serverAddr = "relay.link.shiori.codes"');
    expect(config).toContain("serverPort = 7443");
    expect(config).toContain("transport.tls.enable = true");
    expect(config).toContain("transport.heartbeatInterval = 15");
    expect(config).toContain("transport.heartbeatTimeout = 45");
    expect(config).toContain('auth.additionalScopes = ["HeartBeats", "NewWorkConns"]');
    expect(config).toContain('metadatas.environment_id = "env_12345678"');
    expect(config).toContain('metadatas.connector_token = "connector-token"');
    expect(config).toContain("localPort = 3773");
    expect(config).toContain('type = "http"');
    expect(config).toContain("transport.useEncryption = false");
  });
});
