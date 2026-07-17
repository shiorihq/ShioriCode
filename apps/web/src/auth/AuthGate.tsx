import { useEffect, useState, type ReactNode } from "react";

import {
  hasDesktopNativeBridge,
  isRemoteDesktopConnection,
  setNativeApiWebConnectGate,
} from "../nativeApi";
import { Spinner } from "../components/ui/spinner";
import { fetchAuthSession, type AuthSessionDescriptor } from "./authClient";
import { LoginScreen } from "./LoginScreen";

type GateState =
  | { readonly status: "loading" }
  | { readonly status: "needs-login"; readonly descriptor: AuthSessionDescriptor }
  | { readonly status: "ready" };

/**
 * Gates the web app behind credential login when the server is remote-reachable.
 *
 * The static app shell is public, so this component loads, asks the server
 * whether auth is required, and only renders the app (which opens the WebSocket)
 * once authenticated. On loopback / desktop, or if the probe fails, it fails
 * open — the server remains the real authorization boundary.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>(() =>
    hasDesktopNativeBridge() && !isRemoteDesktopConnection()
      ? { status: "ready" }
      : { status: "loading" },
  );

  useEffect(() => {
    if (state.status !== "loading") {
      if (state.status === "ready") {
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
        setState({ status: "needs-login", descriptor });
      } else {
        setNativeApiWebConnectGate(true);
        setState({ status: "ready" });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [state.status]);

  if (state.status === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-muted-foreground">
        <Spinner className="size-4" />
      </div>
    );
  }

  if (state.status === "needs-login") {
    return (
      <LoginScreen
        authMode={state.descriptor.authMode}
        onSuccess={() => {
          setNativeApiWebConnectGate(true);
          setState({ status: "ready" });
        }}
      />
    );
  }

  return <>{children}</>;
}
