import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCliBaseDir } from "./lib";

describe("resolveCliBaseDir", () => {
  it("defaults to the shared shiori home directory", () => {
    expect(resolveCliBaseDir()).toBe(path.join(os.homedir(), ".shiori"));
  });

  it("expands home-relative paths", () => {
    expect(resolveCliBaseDir("~/custom-shiori")).toBe(path.join(os.homedir(), "custom-shiori"));
  });
});
