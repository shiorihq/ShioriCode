const PARTICLE_COUNT = 12;
const CLEANUP_BUFFER_MS = 250;

type BurstRun = {
  cancel: () => void;
};

const activeBurstByFrame = new WeakMap<HTMLElement, BurstRun>();

function resolveComposerFrame(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>(
      '[data-chat-composer-frame="true"][data-chat-composer-focused="true"]',
    ) ?? document.querySelector<HTMLElement>('[data-chat-composer-frame="true"]')
  );
}

export function playFastModeBlitz(turningOn: boolean): void {
  if (
    typeof document === "undefined" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return;
  }

  const composerFrame = resolveComposerFrame();
  if (!composerFrame) return;

  activeBurstByFrame.get(composerFrame)?.cancel();

  const particles = new Set<HTMLElement>();
  const cleanupTimers = new Map<HTMLElement, number>();
  const fragment = document.createDocumentFragment();
  const emoji = turningOn ? "⚡" : "🐌";
  const minDuration = turningOn ? 800 : 1600;
  const durationSpread = turningOn ? 500 : 900;
  const travelDistance = composerFrame.clientHeight + 56;

  const burstRun: BurstRun = {
    cancel: () => {
      for (const timer of cleanupTimers.values()) window.clearTimeout(timer);
      cleanupTimers.clear();
      for (const particle of particles) particle.remove();
      particles.clear();
      if (activeBurstByFrame.get(composerFrame) === burstRun) {
        activeBurstByFrame.delete(composerFrame);
      }
    },
  };

  activeBurstByFrame.set(composerFrame, burstRun);

  for (let index = 0; index < PARTICLE_COUNT; index += 1) {
    const particle = document.createElement("span");
    const duration = minDuration + Math.random() * durationSpread;
    const delay = Math.random() * 220;
    const cleanup = () => {
      const cleanupTimer = cleanupTimers.get(particle);
      if (cleanupTimer !== undefined) window.clearTimeout(cleanupTimer);
      cleanupTimers.delete(particle);
      particle.remove();
      particles.delete(particle);
      if (particles.size === 0 && activeBurstByFrame.get(composerFrame) === burstRun) {
        activeBurstByFrame.delete(composerFrame);
      }
    };

    particle.textContent = emoji;
    particle.className = "fast-mode-blitz";
    particle.setAttribute("aria-hidden", "true");
    particle.style.left = `${3 + Math.random() * 94}%`;
    particle.style.fontSize = `${14 + Math.random() * 12}px`;
    particle.style.animationDuration = `${duration}ms`;
    particle.style.animationDelay = `${delay}ms`;
    particle.style.setProperty("--fast-mode-blitz-distance", `${travelDistance}px`);
    particle.addEventListener("animationend", cleanup, { once: true });
    cleanupTimers.set(particle, window.setTimeout(cleanup, duration + delay + CLEANUP_BUFFER_MS));
    particles.add(particle);
    fragment.append(particle);
  }

  composerFrame.append(fragment);
}
