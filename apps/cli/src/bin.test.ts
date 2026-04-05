import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "./bin";

describe("shiori cli", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints help without touching the backend", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main(["--help"]);

    expect(log).toHaveBeenCalled();
    expect(log.mock.calls[0]?.[0]).toContain("Usage:");
  });

  it("prints the version without touching the backend", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main(["--version"]);

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/\d+\.\d+\.\d+/);
  });
});
