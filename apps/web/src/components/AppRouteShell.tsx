import { type ComponentType, type ReactNode, useEffect, useState } from "react";

import { AppStartupShell } from "./AppStartupShell";

type AppSidebarLayoutComponent = ComponentType<{ children: ReactNode }>;

export type AppRouteLayoutLoader = {
  getResolved: () => AppSidebarLayoutComponent | null;
  load: () => Promise<AppSidebarLayoutComponent>;
};

let resolvedAppSidebarLayout: AppSidebarLayoutComponent | null = null;
const appSidebarLayoutPromise = import("./AppSidebarLayout").then(({ AppSidebarLayout }) => {
  resolvedAppSidebarLayout = AppSidebarLayout;
  return AppSidebarLayout;
});
// The prefetch starts at module scope and has no consumer until a shell mounts
// with the default loader, so a rejection would otherwise surface as an
// unhandled one. Real consumers await the same promise and still see the
// failure; this only keeps a handler attached from the first tick.
void appSidebarLayoutPromise.catch(() => undefined);

const defaultLayoutLoader: AppRouteLayoutLoader = {
  getResolved: () => resolvedAppSidebarLayout,
  load: () => appSidebarLayoutPromise,
};

export function AppRouteShell({
  children,
  layoutLoader = defaultLayoutLoader,
}: {
  children: ReactNode;
  layoutLoader?: AppRouteLayoutLoader;
}) {
  // Hold the resolved component in state, boxed in an object. A React component
  // is itself a function, so storing one bare makes React invoke it as a lazy
  // initializer without props; the box removes that hazard. Splitting readiness
  // into state while the component lived in a module variable let the two
  // disagree — the shell would report ready with nothing to render and stay on
  // the startup screen forever.
  const [layout, setLayout] = useState<{ readonly Component: AppSidebarLayoutComponent } | null>(
    () => {
      const resolved = layoutLoader.getResolved();
      return resolved === null ? null : { Component: resolved };
    },
  );
  const [loadError, setLoadError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    void layoutLoader.load().then(
      (Component) => {
        if (!cancelled) setLayout({ Component });
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [layoutLoader]);

  if (loadError !== null) throw loadError;

  if (layout === null) return <AppStartupShell />;
  const AppSidebarLayout = layout.Component;

  return (
    <AppSidebarLayout>
      <AppShellReadyMark>{children}</AppShellReadyMark>
    </AppSidebarLayout>
  );
}

function AppShellReadyMark({ children }: { children: ReactNode }) {
  useEffect(() => {
    performance.mark("shioricode-app-shell-ready");
  }, []);

  return <>{children}</>;
}
