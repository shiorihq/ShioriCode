export function playFastModeBlitz(turningOn: boolean): void {
  if (typeof document === "undefined") return;
  const composerFrame = document.querySelector<HTMLElement>('[data-chat-composer-frame="true"]');
  if (!composerFrame) return;

  const count = 12;
  const emoji = turningOn ? "⚡" : "🐌";
  const minDuration = turningOn ? 800 : 1600;
  const durationSpread = turningOn ? 500 : 900;

  for (let i = 0; i < count; i++) {
    const particle = document.createElement("span");
    particle.textContent = emoji;
    particle.className = "fast-mode-blitz";
    particle.style.left = `${3 + Math.random() * 94}%`;
    particle.style.fontSize = `${14 + Math.random() * 12}px`;
    particle.style.animationDuration = `${minDuration + Math.random() * durationSpread}ms`;
    particle.style.animationDelay = `${Math.random() * 220}ms`;
    particle.addEventListener("animationend", () => particle.remove(), { once: true });
    composerFrame.appendChild(particle);
  }
}
