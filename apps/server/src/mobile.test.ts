import { describe, expect, it } from "vitest";

import { type ServerConfigShape } from "./config";
import {
  mobilePairingCandidates,
  mobileSnapshotWaitOptions,
  shouldPersistMobileLastSeen,
} from "./mobile";

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
      label: "Current browser address",
    });
    expect(candidates.some((candidate) => candidate.apiBaseUrl.endsWith(".local:3773"))).toBe(true);
  });

  it("does not expose LAN candidates when the server only listens on loopback", () => {
    const candidates = mobilePairingCandidates(
      config({ host: "127.0.0.1" }),
      new URL("http://127.0.0.1:3773/api/mobile/pairing-sessions"),
    );

    expect(candidates).toEqual([
      {
        apiBaseUrl: "http://127.0.0.1:3773",
        label: "Simulator on this Mac",
      },
    ]);
  });

  it("appends tailscale candidates and dedupes ones already present", () => {
    const candidates = mobilePairingCandidates(
      config({ host: "127.0.0.1" }),
      new URL("http://127.0.0.1:3773/api/mobile/pairing-sessions"),
      [
        { apiBaseUrl: "https://mac.tailnet.ts.net", label: "Tailscale Serve" },
        { apiBaseUrl: "http://127.0.0.1:3773", label: "duplicate loopback" },
      ],
    );

    expect(candidates).toEqual([
      {
        apiBaseUrl: "http://127.0.0.1:3773",
        label: "Simulator on this Mac",
      },
      {
        apiBaseUrl: "https://mac.tailnet.ts.net",
        label: "Tailscale Serve",
      },
    ]);
  });

  it("preserves a reverse-proxied HTTPS origin for remote iOS pairing", () => {
    const candidates = mobilePairingCandidates(
      config({ host: "127.0.0.1" }),
      new URL("https://mac.shiori.ai/api/mobile/pairing-sessions"),
    );

    expect(candidates).toEqual([
      {
        apiBaseUrl: "http://127.0.0.1:3773",
        label: "Simulator on this Mac",
      },
      {
        apiBaseUrl: "https://mac.shiori.ai",
        label: "Current browser address",
      },
    ]);
  });
});

describe("mobileSnapshotWaitOptions", () => {
  it("keeps legacy snapshot requests immediate", () => {
    expect(mobileSnapshotWaitOptions(new URL("http://localhost/api/mobile/snapshot"))).toEqual({
      afterSequence: null,
      waitMs: 0,
    });
  });

  it("accepts a bounded long-poll cursor", () => {
    expect(
      mobileSnapshotWaitOptions(
        new URL("http://localhost/api/mobile/snapshot?after=42&waitMs=20000"),
      ),
    ).toEqual({ afterSequence: 42, waitMs: 20_000 });
  });

  it("rejects invalid cursors and caps excessive waits", () => {
    expect(
      mobileSnapshotWaitOptions(
        new URL("http://localhost/api/mobile/snapshot?after=-1&waitMs=20000"),
      ),
    ).toEqual({ afterSequence: null, waitMs: 0 });
    expect(
      mobileSnapshotWaitOptions(
        new URL("http://localhost/api/mobile/snapshot?after=5&waitMs=999999"),
      ),
    ).toEqual({ afterSequence: 5, waitMs: 25_000 });
  });
});

describe("shouldPersistMobileLastSeen", () => {
  const now = Date.parse("2026-07-17T00:00:30.000Z");

  it("throttles presence writes inside the persistence interval", () => {
    expect(shouldPersistMobileLastSeen("2026-07-17T00:00:01.000Z", now)).toBe(false);
  });

  it("persists stale or malformed presence values", () => {
    expect(shouldPersistMobileLastSeen("2026-07-17T00:00:00.000Z", now)).toBe(true);
    expect(shouldPersistMobileLastSeen("invalid", now)).toBe(true);
  });
});
