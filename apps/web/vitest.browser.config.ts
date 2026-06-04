import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";

import { createWebViteConfig } from "./vite.config";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default mergeConfig(
  createWebViteConfig({ includeRouterPlugin: false }),
  defineConfig({
    resolve: {
      alias: {
        "~": srcPath,
      },
    },
    test: {
      include: ["src/components/**/*.browser.tsx"],
      browser: {
        enabled: true,
        provider: playwright({
          launchOptions: chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : {},
        }),
        instances: [{ browser: "chromium" }],
        headless: true,
      },
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  }),
);
