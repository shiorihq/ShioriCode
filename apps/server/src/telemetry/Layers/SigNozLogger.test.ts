import { describe, expect, it } from "vitest";

import { encodeSigNozLogPayload } from "./SigNozLogger.ts";

describe("SigNozLogger", () => {
  it("encodes structured Effect logs as OTLP json payloads", () => {
    const payload = encodeSigNozLogPayload({
      logs: [
        {
          message: "web.unhandled_error",
          level: "ERROR",
          timestamp: "2026-04-08T12:00:00.000Z",
          cause: "Error: boom",
          annotations: {
            source: "web-client",
            path: "/settings/general",
          },
          spans: {
            startup: 42,
          },
          fiberId: "#123",
        },
      ],
      serviceName: "shioricode",
      serviceVersion: "0.1.0",
      deploymentEnvironment: "development",
      runtimeMode: "web",
    });

    expect(payload).toMatchObject({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  severityNumber: 17,
                  severityText: "ERROR",
                  body: {
                    stringValue: "web.unhandled_error",
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(JSON.stringify(payload)).toContain("service.name");
    expect(JSON.stringify(payload)).toContain("web-client");
    expect(JSON.stringify(payload)).toContain("/settings/general");
  });
});
