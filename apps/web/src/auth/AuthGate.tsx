import { useEffect, useState, type ReactNode } from "react";

import { hasDesktopNativeBridge, setNativeApiWebConnectGate } from "../nativeApi";
import { Spinner } from "../components/ui/spinner";
import { fetchAuthSession } from "./authClient";
import { LoginScreen } from "./LoginScreen";

type GateStatus = "loading" | "needs-login" | "ready";

/**
 * Gates the web app behind credential login when the server is remote-reachable.
 *
 * The static app shell is public, so this component loads, asks the server
 * whether auth is required, and only renders the app (which opens the WebSocket)
 * once authenticated. On loopback / desktop, or if the probe fails, it fails
 * open — the server remains the real authorization boundary.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<GateStatus>(() =>
    hasDesktopNativeBridge() ? "ready" : "loading",
  );

  useEffect(() => {
    if (status !== "loading") {
      if (status === "ready") {
        setNativeApiWebConnectGate(true);
      }
      return;
    }

    let cancelled = false;
    void fetchAuthSession().then((descriptor) => {
      if (cancelled) {
        return;
      }
      if (descriptor && descriptor.requireAuth && !descriptor.authenticated) {
        setNativeApiWebConnectGate(false);
        setStatus("needs-login");
      } else {
        setNativeApiWebConnectGate(true);
        setStatus("ready");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [status]);

  if (status === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-muted-foreground">
        <Spinner className="size-4" />
      </div>
    );
  }

  if (status === "needs-login") {
    return (
      <LoginScreen
        onSuccess={() => {
          setNativeApiWebConnectGate(true);
          setStatus("ready");
        }}
      />
    );
  }

  return <>{children}</>;
}
