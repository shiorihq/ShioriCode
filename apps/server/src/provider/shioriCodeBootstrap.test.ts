import assert from "node:assert/strict";

import { Effect } from "effect";
import { afterEach, describe, it, vi } from "vitest";

import { fetchShioriCodeBootstrap } from "./shioriCodeBootstrap.ts";

function encodeBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

const validHostedAuthToken = `${encodeBase64UrlJson({ alg: "RS256" })}.${encodeBase64UrlJson({
  iss: "https://cautious-puma-129.convex.site",
  aud: "convex",
  sub: "user|session",
})}.signature`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchShioriCodeBootstrap", () => {
  it("keeps conservative approval policies for an empty bootstrap payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    );

    const result = await Effect.runPromise(
      fetchShioriCodeBootstrap({
        apiBaseUrl: "http://shiori.test",
        authToken: validHostedAuthToken,
      }),
    );

    assert.equal(result.message, null);
    assert.equal(result.bootstrap?.approvalPolicies.fileWrite, "ask");
    assert.equal(result.bootstrap?.approvalPolicies.shellCommand, "ask");
    assert.equal(result.bootstrap?.approvalPolicies.mcpSideEffect, "ask");
    assert.equal(result.bootstrap?.subagents?.enabled, false);
  });

  it("uses conservative defaults and reports a warning when bootstrap JSON is invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{", { status: 200 })),
    );

    const result = await Effect.runPromise(
      fetchShioriCodeBootstrap({
        apiBaseUrl: "http://shiori.test",
        authToken: validHostedAuthToken,
      }),
    );

    assert.match(result.message ?? "", /Failed to parse/i);
    assert.equal(result.bootstrap?.approvalPolicies.fileWrite, "ask");
    assert.equal(result.bootstrap?.approvalPolicies.mcpSideEffect, "ask");
  });

  it("deep-merges partial hosted policies into conservative defaults", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              approvalPolicies: {
                fileWrite: "allow",
              },
              subagents: {
                enabled: true,
                profiles: {
                  codex: {
                    supported: true,
                    tools: ["spawn_agent"],
                  },
                },
              },
            }),
            { status: 200 },
          ),
      ),
    );

    const result = await Effect.runPromise(
      fetchShioriCodeBootstrap({
        apiBaseUrl: "http://shiori.test",
        authToken: validHostedAuthToken,
      }),
    );

    assert.equal(result.bootstrap?.approvalPolicies.fileWrite, "allow");
    assert.equal(result.bootstrap?.approvalPolicies.shellCommand, "ask");
    assert.equal(result.bootstrap?.approvalPolicies.mcpSideEffect, "ask");
    assert.equal(result.bootstrap?.subagents?.enabled, true);
    assert.deepEqual(result.bootstrap?.subagents?.profiles.codex?.tools, ["spawn_agent"]);
  });
});
