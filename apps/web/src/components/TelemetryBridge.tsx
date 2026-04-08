import { useLocation } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { logTelemetryErrorOnce, recordTelemetry } from "../telemetry";

function truncate(value: string, maxLength = 4_000): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function describeUnknown(value: unknown): string {
  if (value instanceof Error) {
    return truncate(value.stack ?? value.message);
  }
  if (typeof value === "string") {
    return truncate(value);
  }
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return truncate(String(value));
  }
}

export function TelemetryBridge() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const appLoadedRef = useRef(false);
  const lastRouteRef = useRef<string | null>(null);

  useEffect(() => {
    if (appLoadedRef.current) {
      return;
    }
    appLoadedRef.current = true;
    recordTelemetry("web.app.loaded");
  }, []);

  useEffect(() => {
    if (lastRouteRef.current === pathname) {
      return;
    }
    lastRouteRef.current = pathname;
    recordTelemetry("web.route.viewed", {
      path: pathname,
    });
  }, [pathname]);

  const handleWindowError = useEffectEvent((event: ErrorEvent) => {
    logTelemetryErrorOnce("web.unhandled_error", {
      path: pathname,
      message: event.message,
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
      error: describeUnknown(event.error),
    });
  });

  const handleUnhandledRejection = useEffectEvent((event: PromiseRejectionEvent) => {
    logTelemetryErrorOnce("web.unhandled_rejection", {
      path: pathname,
      reason: describeUnknown(event.reason),
    });
  });

  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      handleWindowError(event);
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      handleUnhandledRejection(event);
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return null;
}
