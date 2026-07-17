import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LinkRemote } from "./LinkRemote";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function makeRemote(callbackScheme: string): Promise<LinkRemote> {
  const stateDir = await mkdtemp(join(tmpdir(), "shioricode-link-"));
  temporaryDirectories.push(stateDir);
  return new LinkRemote({ stateDir, localPort: 43123, callbackScheme });
}

describe("LinkRemote", () => {
  it("targets the development desktop protocol without waking production", async () => {
    const remote = await makeRemote("shioricode-dev");
    const result = remote.beginSignIn({ provider: "github" });
    const redirect = new URL(result.authUrl).searchParams.get("redirect");

    expect(redirect).toBe("shioricode-dev://app/index.html?link-auth=callback");
    await remote.dispose();
  });

  it("rejects arbitrary callback schemes", async () => {
    const remote = await makeRemote("javascript");
    const result = remote.beginSignIn({ provider: "github" });
    const redirect = new URL(result.authUrl).searchParams.get("redirect");

    expect(redirect).toBe("shioricode://app/index.html?link-auth=callback");
    await remote.dispose();
  });
});
