import { Suspense, lazy, useSyncExternalStore, type CSSProperties } from "react";

const MetalFx = lazy(async () => {
  const module = await import("metal-fx");
  return { default: module.MetalFx };
});

const metalBorderMaskStyle = {
  WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
  WebkitMaskComposite: "xor",
  maskComposite: "exclude",
} satisfies CSSProperties;

const metalFxStyle = {
  position: "absolute",
  inset: 0,
  color: "inherit",
  background: "transparent",
} satisfies CSSProperties;

type Appearance = "dark" | "light";
type AppearanceSubscriber = () => void;

const appearanceSubscribers = new Set<AppearanceSubscriber>();
let appearanceObserver: MutationObserver | null = null;

function readAppearance(): Appearance {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
}

function readServerAppearance(): Appearance {
  return "light";
}

function subscribeToAppearance(subscriber: AppearanceSubscriber): () => void {
  appearanceSubscribers.add(subscriber);
  if (!appearanceObserver && typeof MutationObserver !== "undefined") {
    appearanceObserver = new MutationObserver(() => {
      for (const notify of appearanceSubscribers) notify();
    });
    appearanceObserver.observe(document.documentElement, {
      attributeFilter: ["class"],
      attributes: true,
    });
  }

  return () => {
    appearanceSubscribers.delete(subscriber);
    if (appearanceSubscribers.size === 0) {
      appearanceObserver?.disconnect();
      appearanceObserver = null;
    }
  };
}

export function UltrathinkMetalRing({ borderRadius }: { borderRadius: number }) {
  const appearance = useSyncExternalStore(
    subscribeToAppearance,
    readAppearance,
    readServerAppearance,
  );

  return (
    <Suspense fallback={null}>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-30"
        data-chat-ultrathink-metal-ring="true"
      >
        <div className="absolute inset-0 p-px" style={{ ...metalBorderMaskStyle, borderRadius }}>
          <MetalFx
            preset="chromatic"
            theme={appearance}
            strength={0.9}
            paused={false}
            disableGlow
            normalizeHostStyles={false}
            borderRadius={borderRadius}
            ringCssPx={5}
            className="h-full w-full"
            style={metalFxStyle}
          >
            <div className="h-full w-full" style={{ borderRadius, pointerEvents: "none" }} />
          </MetalFx>
        </div>
      </div>
    </Suspense>
  );
}
