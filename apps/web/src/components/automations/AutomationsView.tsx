import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Automation, AutomationCreateInput, AutomationListResult } from "contracts";

import { SidebarInset } from "~/components/ui/sidebar";
import { toastManager } from "~/components/ui/toast";
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";

import { AutomationsList } from "./AutomationsList";
import { NewAutomationDialog } from "./NewAutomationDialog";
import { type AutomationFilter } from "./automationShared";

const AUTOMATIONS_LOAD_TIMEOUT_MS = 8_000;

interface AutomationsViewProps {
  search: { filter?: AutomationFilter | undefined };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

export function AutomationsView({ search }: AutomationsViewProps) {
  const navigate = useNavigate();
  const filter: AutomationFilter = search.filter ?? "all";

  const [result, setResult] = useState<AutomationListResult>({ automations: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (options?: { readonly quiet?: boolean }) => {
    if (!options?.quiet) {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const next = await withTimeout(
        ensureNativeApi().automations.list(),
        AUTOMATIONS_LOAD_TIMEOUT_MS,
        "Timed out while loading automations.",
      );
      if (mountedRef.current) {
        setResult(next);
        setLoadError(null);
      }
    } catch (error: unknown) {
      const description = error instanceof Error ? error.message : "Try again in a moment.";
      if (mountedRef.current && !options?.quiet) {
        setLoadError(description);
        toastManager.add({
          type: "error",
          title: "Failed to load automations",
          description,
        });
      }
    } finally {
      if (mountedRef.current && !options?.quiet) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") {
        void refresh({ quiet: true });
      }
    };
    const interval = window.setInterval(refreshIfVisible, 30_000);
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [refresh]);

  const changeFilter = useCallback(
    (nextFilter: AutomationFilter) => {
      void navigate({ to: "/automations", search: { filter: nextFilter } });
    },
    [navigate],
  );

  const createAutomation = useCallback(async (input: AutomationCreateInput) => {
    setCreating(true);
    try {
      const next = await ensureNativeApi().automations.create(input);
      if (!mountedRef.current) {
        return;
      }
      setResult(next);
      toastManager.add({ type: "success", title: "Automation created" });
      setDialogOpen(false);
    } catch (error: unknown) {
      if (!mountedRef.current) {
        return;
      }
      toastManager.add({
        type: "error",
        title: "Failed to create automation",
        description: error instanceof Error ? error.message : "Try again in a moment.",
      });
    } finally {
      if (mountedRef.current) {
        setCreating(false);
      }
    }
  }, []);

  const runNow = useCallback(async (automationId: Automation["id"]) => {
    try {
      const next = await ensureNativeApi().automations.runNow({ automationId });
      if (!mountedRef.current) {
        return;
      }
      setResult(next);
      toastManager.add({ type: "success", title: "Automation queued" });
    } catch (error: unknown) {
      if (!mountedRef.current) {
        return;
      }
      toastManager.add({
        type: "error",
        title: "Failed to queue automation",
        description: error instanceof Error ? error.message : "Try again in a moment.",
      });
    }
  }, []);

  const toggleStatus = useCallback(async (automation: Automation) => {
    const status = automation.status === "active" ? "paused" : "active";
    try {
      const next = await ensureNativeApi().automations.update({
        automationId: automation.id,
        status,
      });
      if (mountedRef.current) {
        setResult(next);
      }
    } catch (error: unknown) {
      if (!mountedRef.current) {
        return;
      }
      toastManager.add({
        type: "error",
        title: "Failed to update automation",
        description: error instanceof Error ? error.message : "Try again in a moment.",
      });
    }
  }, []);

  const deleteAutomation = useCallback(async (automationId: Automation["id"]) => {
    try {
      const next = await ensureNativeApi().automations.delete({ automationId });
      if (mountedRef.current) {
        setResult(next);
      }
    } catch (error: unknown) {
      if (!mountedRef.current) {
        return;
      }
      toastManager.add({
        type: "error",
        title: "Failed to delete automation",
        description: error instanceof Error ? error.message : "Try again in a moment.",
      });
    }
  }, []);

  const columnClass = "mx-auto w-full max-w-3xl px-4";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="relative isolate flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background [contain:paint]">
          {isElectron ? (
            <div className="drag-region flex h-[52px] shrink-0 items-center" />
          ) : (
            <header className="flex h-12 shrink-0 items-center">
              <div className={cn(columnClass, "flex h-full items-center")} />
            </header>
          )}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <AutomationsList
              automations={result.automations}
              loading={loading}
              loadError={loadError}
              filter={filter}
              columnClass={columnClass}
              onFilterChange={changeFilter}
              onRefresh={() => void refresh()}
              onCreate={() => setDialogOpen(true)}
              onRunNow={(automationId) => void runNow(automationId)}
              onToggleStatus={(automation) => void toggleStatus(automation)}
              onDelete={(automationId) => void deleteAutomation(automationId)}
            />
          </div>
        </div>
      </div>
      <NewAutomationDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreate={createAutomation}
        isCreating={creating}
      />
    </SidebarInset>
  );
}
