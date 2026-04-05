import type { CSSProperties } from "react";

/**
 * Generates a deterministic gradient based on a stable user identifier.
 * Used as the avatar fallback when no profile picture is set.
 */
export function getAvatarGradientStyle(input: string): CSSProperties {
  const hash = input.split("").reduce((acc, char) => char.charCodeAt(0) + acc, 0);
  const hueOffset = (hash % 20) - 10;
  const baseHue = 241;
  const hue1 = baseHue + hueOffset;
  const hue2 = baseHue + hueOffset + 15;
  const lightness1 = 0.58 + (hash % 10) / 100;
  const lightness2 = 0.48 + (hash % 10) / 100;

  return {
    background: `linear-gradient(135deg, oklch(${lightness1} 0.13 ${hue1}), oklch(${lightness2} 0.15 ${hue2}))`,
  };
}
