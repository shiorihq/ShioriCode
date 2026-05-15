import { describe, expect, it } from "vitest";

import { type ServerConfigShape } from "./config";
import { mobilePairingCandidates } from "./mobile";

function config(overrides: Partial<ServerConfigShape>): ServerConfigShape {
  return {
    port: 3773,
    host: "0.0.0.0",
    ...overrides,
  } as ServerConfigShape;
}

describe("mobilePairingCandidates", () => {
  it("includes request and local hostname candidates for LAN listeners", () => {
    const candidates = mobilePairingCandidates(
      config({ host: "0.0.0.0" }),
      new URL("http://192.168.1.44:3773/api/mobile/pairing-sessions"),
    );

    expect(candidates).toContainEqual({
      apiBaseUrl: "http://127.0.0.1:3773",
      label: "Simulator on this Mac",
    });
    expect(candidates).toContainEqual({
      apiBaseUrl: "http://192.168.1.44:3773",
      label: "Current desktop address",
    });
    expect(candidates.some((candidate) => candidate.apiBaseUrl.endsWith(".local:3773"))).toBe(true);
  });

  it("does not expose LAN candidates when the server only listens on loopback", () => {
    const candidates = mobilePairingCandidates(
      config({ host: "127.0.0.1" }),
      new URL("http://192.168.1.44:3773/api/mobile/pairing-sessions"),
    );

    expect(candidates).toEqual([
      {
        apiBaseUrl: "http://127.0.0.1:3773",
        label: "Simulator on this Mac",
      },
    ]);
  });
});
