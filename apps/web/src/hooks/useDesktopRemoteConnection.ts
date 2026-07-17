import type { DesktopRemoteConnectionState } from "contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

const LOCAL_CONNECTION: DesktopRemoteConnectionState = {
  mode: "local",
  remoteUrl: null,
  savedRemoteUrls: [],
};

export const LOCAL_DESKTOP_CONNECTION_VALUE = "__local__";

export function desktopRemoteLabel(remoteUrl: string): string {
  try {
    return new URL(remoteUrl).hostname;
  } catch {
    return remoteUrl;
  }
}

export function useDesktopRemoteConnection() {
  const bridge = window.desktopBridge;
  const supported =
    typeof bridge?.getRemoteConnection === "function" &&
    typeof bridge.connectToRemote === "function" &&
    typeof bridge.disconnectFromRemote === "function";
  const [connection, setConnection] = useState<DesktopRemoteConnectionState>(LOCAL_CONNECTION);
  const [loading, setLoading] = useState(supported);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported || !bridge?.getRemoteConnection) return;
    let cancelled = false;
    void bridge
      .getRemoteConnection()
      .then((next) => {
        if (!cancelled) setConnection(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Could not load remote connections.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, supported]);

  const connect = useCallback(
    async (remoteUrl: string) => {
      if (!bridge?.connectToRemote) return false;
      setBusy(true);
      setError(null);
      try {
        const result = await bridge.connectToRemote(remoteUrl);
        setConnection(result.state);
        if (!result.ok) {
          setError(result.error ?? "The remote could not be reached.");
          return false;
        }
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The remote could not be reached.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [bridge],
  );

  const useLocal = useCallback(async () => {
    if (!bridge?.disconnectFromRemote) return false;
    setBusy(true);
    setError(null);
    try {
      setConnection(await bridge.disconnectFromRemote());
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not switch to this computer.");
      return false;
    } finally {
      setBusy(false);
    }
  }, [bridge]);

  const label = useMemo(
    () => (connection.remoteUrl ? desktopRemoteLabel(connection.remoteUrl) : "This computer"),
    [connection.remoteUrl],
  );

  return { busy, connect, connection, error, label, loading, supported, useLocal };
}
