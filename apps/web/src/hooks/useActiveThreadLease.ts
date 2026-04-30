import { ThreadId } from "contracts";
import { useEffect } from "react";

import { releaseThreadLease, renewThreadLease } from "../lib/threadLease";

const THREAD_LEASE_HEARTBEAT_MS = 5_000;

export function useActiveThreadLease(threadId: ThreadId | null): void {
  useEffect(() => {
    if (!threadId) {
      return;
    }

    let intervalId: number | null = null;

    const stopHeartbeat = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };

    const startHeartbeat = () => {
      stopHeartbeat();
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }

      renewThreadLease(threadId);
      intervalId = window.setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) {
          return;
        }
        renewThreadLease(threadId);
      }, THREAD_LEASE_HEARTBEAT_MS);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopHeartbeat();
        releaseThreadLease(threadId);
        return;
      }
      startHeartbeat();
    };

    const handlePageHide = () => {
      stopHeartbeat();
      releaseThreadLease(threadId);
    };

    startHeartbeat();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);

    return () => {
      stopHeartbeat();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      releaseThreadLease(threadId);
    };
  }, [threadId]);
}

export function useActiveThreadLeases(threadIds: readonly ThreadId[]): void {
  const threadLeaseKey = threadIds.join("\0");

  useEffect(() => {
    const leasedThreadIds = threadLeaseKey
      .split("\0")
      .filter((threadId) => threadId.length > 0)
      .map((threadId) => ThreadId.makeUnsafe(threadId));
    if (leasedThreadIds.length === 0) {
      return;
    }

    let intervalId: number | null = null;

    const stopHeartbeat = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };

    const renewLeases = () => {
      for (const leasedThreadId of leasedThreadIds) {
        renewThreadLease(leasedThreadId);
      }
    };

    const releaseLeases = () => {
      for (const leasedThreadId of leasedThreadIds) {
        releaseThreadLease(leasedThreadId);
      }
    };

    const startHeartbeat = () => {
      stopHeartbeat();
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }

      renewLeases();
      intervalId = window.setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) {
          return;
        }
        renewLeases();
      }, THREAD_LEASE_HEARTBEAT_MS);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopHeartbeat();
        releaseLeases();
        return;
      }
      startHeartbeat();
    };

    const handlePageHide = () => {
      stopHeartbeat();
      releaseLeases();
    };

    startHeartbeat();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);

    return () => {
      stopHeartbeat();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      releaseLeases();
    };
  }, [threadLeaseKey]);
}
