import { describe, expect, it } from "vitest";
import { resolveThemeMode } from "./theme";
import {
  isDarkLuminance,
  meanLuminanceFromPixels,
  scrimBoostFromLuminance,
} from "./wallpaperLuminance";

function pixels(...rgb: ReadonlyArray<readonly [number, number, number]>): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgb.length * 4);
  rgb.forEach(([r, g, b], index) => {
    out[index * 4] = r;
    out[index * 4 + 1] = g;
    out[index * 4 + 2] = b;
    out[index * 4 + 3] = 255;
  });
  return out;
}

describe("meanLuminanceFromPixels", () => {
  it("returns the extremes for solid black and solid white", () => {
    expect(meanLuminanceFromPixels(pixels([0, 0, 0]))).toBeCloseTo(0, 5);
    expect(meanLuminanceFromPixels(pixels([255, 255, 255]))).toBeCloseTo(1, 5);
  });

  it("averages in linear light, so half black and half white reads as mid-grey", () => {
    // The point of the linearisation: averaging the sRGB bytes instead would
    // give 0.5 encoded, which is ~0.73 of the light actually reaching the eye,
    // and every checkerboard photo would be misread as bright.
    const halfAndHalf = meanLuminanceFromPixels(pixels([0, 0, 0], [255, 255, 255]));
    expect(halfAndHalf).toBeCloseTo(0.5, 5);
  });

  it("weights green the most, matching how the eye reads brightness", () => {
    const green = meanLuminanceFromPixels(pixels([0, 255, 0]));
    const red = meanLuminanceFromPixels(pixels([255, 0, 0]));
    const blue = meanLuminanceFromPixels(pixels([0, 0, 255]));
    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
  });

  it("skips fully transparent pixels rather than counting them as black", () => {
    const withHole = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 0]);
    expect(meanLuminanceFromPixels(withHole)).toBeCloseTo(1, 5);
  });

  it("falls back to mid-grey when there is nothing to measure", () => {
    expect(meanLuminanceFromPixels(new Uint8ClampedArray())).toBe(0.5);
  });
});

describe("isDarkLuminance", () => {
  it("asks for light text over a dark photo and dark text over a bright one", () => {
    expect(isDarkLuminance(0.05)).toBe(true);
    expect(isDarkLuminance(0.95)).toBe(false);
  });
});

describe("scrimBoostFromLuminance", () => {
  it("peaks at mid-grey, where neither appearance has room", () => {
    expect(scrimBoostFromLuminance(0.5)).toBeCloseTo(1, 5);
  });

  it("costs nothing at either extreme, where the theme ramp already clears", () => {
    expect(scrimBoostFromLuminance(0)).toBeCloseTo(0, 5);
    expect(scrimBoostFromLuminance(1)).toBeCloseTo(0, 5);
  });

  it("stays within 0..1 for out-of-range input", () => {
    expect(scrimBoostFromLuminance(-1)).toBe(0);
    expect(scrimBoostFromLuminance(2)).toBe(0);
  });
});

describe("resolveThemeMode with a wallpaper", () => {
  it("follows the wallpaper when it has been sampled", () => {
    expect(resolveThemeMode("wallpaper", false, true)).toBe("dark");
    expect(resolveThemeMode("wallpaper", true, false)).toBe("light");
  });

  it("degrades to the system appearance before the first sample lands", () => {
    expect(resolveThemeMode("wallpaper", true, null)).toBe("dark");
    expect(resolveThemeMode("wallpaper", false, null)).toBe("light");
  });

  it("leaves the explicit modes alone whatever the wallpaper says", () => {
    expect(resolveThemeMode("light", true, true)).toBe("light");
    expect(resolveThemeMode("dark", false, false)).toBe("dark");
    expect(resolveThemeMode("system", true, false)).toBe("dark");
  });
});
