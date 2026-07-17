import { describe, expect, it } from "vitest";

import { parseServeStatusJson, parseServeStatusText, setTailscaleOperator } from "./tailscale";

describe("parseServeStatusJson", () => {
  it("reports off for an empty or missing config", () => {
    expect(parseServeStatusJson(null, 3773)).toEqual({ method: "off", url: null });
    expect(parseServeStatusJson({}, 3773)).toEqual({ method: "off", url: null });
    expect(parseServeStatusJson("nonsense", 3773)).toEqual({ method: "off", url: null });
  });

  it("detects a serve config proxying to our port", () => {
    const config = {
      TCP: { "443": { HTTPS: true } },
      Web: {
        "machine.tailnet.ts.net:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } },
        },
      },
    };
    expect(parseServeStatusJson(config, 3773)).toEqual({
      method: "tailscale-serve",
      url: "https://machine.tailnet.ts.net",
    });
  });

  it("detects funnel via AllowFunnel", () => {
    const config = {
      Web: {
        "machine.tailnet.ts.net:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } },
        },
      },
      AllowFunnel: { "machine.tailnet.ts.net:443": true },
    };
    expect(parseServeStatusJson(config, 3773)).toEqual({
      method: "tailscale-funnel",
      url: "https://machine.tailnet.ts.net",
    });
  });

  it("maps port 80 to an http URL", () => {
    const config = {
      Web: {
        "machine.tailnet.ts.net:80": {
          Handlers: { "/": { Proxy: "http://localhost:3773" } },
        },
      },
    };
    expect(parseServeStatusJson(config, 3773)).toEqual({
      method: "tailscale-serve",
      url: "http://machine.tailnet.ts.net",
    });
  });

  it("ignores configs that proxy to a different port", () => {
    const config = {
      Web: {
        "machine.tailnet.ts.net:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } },
        },
      },
    };
    expect(parseServeStatusJson(config, 3773)).toEqual({ method: "off", url: null });
  });

  it("does not confuse a prefixed port with ours", () => {
    const config = {
      Web: {
        "machine.tailnet.ts.net:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:37730" } },
        },
      },
    };
    expect(parseServeStatusJson(config, 3773)).toEqual({ method: "off", url: null });
  });
});

describe("parseServeStatusText", () => {
  it("reports off for empty output or no-config messages", () => {
    expect(parseServeStatusText("", 3773)).toEqual({ method: "off", url: null });
    expect(parseServeStatusText("No serve config", 3773)).toEqual({ method: "off", url: null });
  });

  it("detects serve targeting our port and extracts the URL", () => {
    const text = [
      "https://machine.tailnet.ts.net (tailnet only)",
      "|-- / proxy http://127.0.0.1:3773",
    ].join("\n");
    expect(parseServeStatusText(text, 3773)).toEqual({
      method: "tailscale-serve",
      url: "https://machine.tailnet.ts.net",
    });
  });

  it("detects funnel from the text output", () => {
    const text = [
      "https://machine.tailnet.ts.net (Funnel on)",
      "|-- / proxy http://127.0.0.1:3773",
    ].join("\n");
    expect(parseServeStatusText(text, 3773).method).toBe("tailscale-funnel");
  });

  it("ignores configs for other ports", () => {
    const text = [
      "https://machine.tailnet.ts.net (tailnet only)",
      "|-- / proxy http://127.0.0.1:9999",
    ].join("\n");
    expect(parseServeStatusText(text, 3773)).toEqual({ method: "off", url: null });
  });
});

describe("setTailscaleOperator", () => {
  it("fails with install guidance when the CLI is unavailable", async () => {
    await expect(setTailscaleOperator(null, "shioricode")).rejects.toThrow(
      "Tailscale isn't installed",
    );
  });
});
