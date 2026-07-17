import { Component, lazy, Suspense, useState, type ComponentType, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { DotMatrixCommonProps } from "~/lib/dotmatrix-core";
import { DotmHex5 } from "./dotm-hex-5";

type DotMatrixLoaderModule = Record<string, ComponentType<DotMatrixCommonProps>>;
type DotMatrixModuleLoader = () => Promise<DotMatrixLoaderModule>;

const dotMatrixModuleLoaders = Object.values(
  import.meta.glob<DotMatrixLoaderModule>("./dotm-*.tsx"),
);

export const DOT_MATRIX_LOADER_COUNT = dotMatrixModuleLoaders.length;

function resolveLoaderComponent(module: DotMatrixLoaderModule) {
  const entry = Object.entries(module).find(
    ([exportName, value]) => exportName.startsWith("Dotm") && typeof value === "function",
  );

  if (!entry) {
    throw new Error("Dot Matrix module did not export a loader component.");
  }

  return entry[1];
}

function pickRandomModuleLoader(): DotMatrixModuleLoader {
  const index = Math.floor(Math.random() * dotMatrixModuleLoaders.length);
  const loader = dotMatrixModuleLoaders[index];

  if (!loader) {
    throw new Error("No Dot Matrix loader modules are available.");
  }

  return loader;
}

function createRandomLoaderComponent() {
  const loadModule = pickRandomModuleLoader();
  return lazy(async () => ({ default: resolveLoaderComponent(await loadModule()) }));
}

interface DotMatrixLoaderFrameProps {
  ariaLabel: string;
  className?: string | undefined;
  size: number;
}

function SpiralLatticeFrame({ ariaLabel, className, size }: DotMatrixLoaderFrameProps) {
  return (
    <DotmHex5
      ariaLabel={ariaLabel}
      boxSize={size}
      className={cn("shrink-0 text-current", className)}
    />
  );
}

interface LoaderErrorBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
}

class LoaderErrorBoundary extends Component<LoaderErrorBoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function RandomDotMatrixLoader({
  ariaLabel = "Working",
  className,
  size = 18,
}: Partial<DotMatrixLoaderFrameProps>) {
  const [Loader] = useState(createRandomLoaderComponent);
  const fallback = <SpiralLatticeFrame ariaLabel={ariaLabel} className={className} size={size} />;

  return (
    <LoaderErrorBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <Loader
          ariaLabel={ariaLabel}
          boxSize={size}
          className={cn("shrink-0 text-current", className)}
        />
      </Suspense>
    </LoaderErrorBoundary>
  );
}

export function SpiralLatticeLoader({
  ariaLabel = "Working",
  className,
  size = 12,
}: Partial<DotMatrixLoaderFrameProps>) {
  return <SpiralLatticeFrame ariaLabel={ariaLabel} className={className} size={size} />;
}
