import { Spinner } from "./ui/spinner";

export function AppStartupShell() {
  return (
    <div
      className="flex h-dvh overflow-hidden bg-background text-foreground"
      data-testid="app-startup-shell"
    >
      <aside className="hidden w-60 shrink-0 border-r border-hairline bg-sidebar px-3 py-4 sm:flex sm:flex-col">
        <div className="px-2 text-sm font-semibold tracking-tight">Shiori Code</div>
        <div className="mt-6 space-y-2" aria-hidden>
          <StartupBar className="w-24" />
          <StartupBar className="w-20" />
          <StartupBar className="w-28" />
        </div>
        <div className="mt-7 px-2 text-[11px] font-medium text-muted-foreground">Projects</div>
        <div className="mt-3 space-y-2" aria-hidden>
          <StartupBar className="w-32" />
          <StartupBar className="w-24" />
          <StartupBar className="w-28" />
        </div>
        <div className="mt-auto px-2 text-xs text-muted-foreground">Settings</div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="h-12 shrink-0 border-b border-hairline" />
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Spinner className="size-3.5" />
            Loading your workspace
          </div>
        </div>
      </main>
    </div>
  );
}

function StartupBar({ className }: { className: string }) {
  return <div className={`h-2 rounded-full bg-muted ${className}`} />;
}
