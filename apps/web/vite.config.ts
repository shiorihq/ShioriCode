import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import type { PluginOption, UserConfig } from "vite";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

const port = Number(process.env.PORT ?? 5733);
const host = process.env.VITE_DEV_SERVER_HOST ?? "127.0.0.1";
const sourcemapEnv = process.env.SHIORICODE_WEB_SOURCEMAP?.trim().toLowerCase();

const buildSourcemap =
  sourcemapEnv === "0" || sourcemapEnv === "false"
    ? false
    : sourcemapEnv === "hidden"
      ? "hidden"
      : true;

type WebViteConfigOptions = {
  includeRouterPlugin?: boolean;
};

function sanitizeChunkSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9-_]/g, "-");
}

export function createWebViteConfig(options: WebViteConfigOptions = {}): UserConfig {
  const plugins: PluginOption[] = [
    ...(options.includeRouterPlugin === false
      ? []
      : [
          tanstackRouter({
            autoCodeSplitting: true,
          }),
        ]),
    react(),
    babel({
      // We need to be explicit about the parser options after moving to @vitejs/plugin-react v6.0.0
      // This is because the babel plugin only automatically parses typescript and jsx based on relative paths (e.g. "**/*.ts")
      // whereas the previous version of the plugin parsed all files with a .ts extension.
      // This is causing our packages/ directory to fail to parse, as they are not relative to the CWD.
      parserOpts: { plugins: ["typescript", "jsx"] },
      presets: [reactCompilerPreset()],
    }),
    tailwindcss(),
  ];

  return {
    plugins,
    optimizeDeps: {
      include: [
        "@base-ui/react/field",
        "@pierre/diffs",
        "@pierre/diffs/react",
        "@pierre/diffs/worker/worker.js",
        "rehype-raw",
      ],
    },
    define: {
      // In dev mode, tell the web app where the WebSocket server lives
      "import.meta.env.VITE_WS_URL": JSON.stringify(process.env.VITE_WS_URL ?? ""),
      "import.meta.env.APP_VERSION": JSON.stringify(pkg.version),
    },
    resolve: {
      tsconfigPaths: true,
    },
    server: {
      host,
      port,
      strictPort: true,
      hmr: {
        // Explicit config so Vite's HMR WebSocket connects reliably
        // inside Electron's BrowserWindow. Vite 8 uses console.debug for
        // connection logs — enable "Verbose" in DevTools to see them.
        protocol: "ws",
        host,
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      rolldownOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) {
              return undefined;
            }
            const normalizedId = id.replace(/\\/g, "/");
            const nodeModulesPath = normalizedId.split("/node_modules/").at(-1);
            if (!nodeModulesPath) {
              return undefined;
            }

            if (
              nodeModulesPath.startsWith("@shikijs/langs/") ||
              nodeModulesPath.startsWith("@shikijs/themes/")
            ) {
              const segments = nodeModulesPath.split("/");
              const packageName = sanitizeChunkSegment(segments.slice(0, 2).join("-"));
              const moduleName = sanitizeChunkSegment(
                segments.at(-1)?.replace(/\.[^.]+$/, "") ?? "module",
              );
              return `vendor-${packageName}-${moduleName}`;
            }

            if (nodeModulesPath.startsWith("@pierre/diffs")) {
              return "vendor-diffs";
            }
            if (nodeModulesPath.startsWith("@tanstack/")) {
              return "vendor-tanstack";
            }
            if (
              nodeModulesPath.startsWith("@base-ui/") ||
              nodeModulesPath.startsWith("lucide-react") ||
              nodeModulesPath.startsWith("framer-motion") ||
              nodeModulesPath.startsWith("@dnd-kit/")
            ) {
              return "vendor-ui";
            }
            if (
              nodeModulesPath.startsWith("convex") ||
              nodeModulesPath.startsWith("@convex-dev/") ||
              nodeModulesPath.startsWith("@auth/core")
            ) {
              return "vendor-auth";
            }
            if (
              nodeModulesPath.startsWith("react-markdown") ||
              nodeModulesPath.startsWith("remark-gfm") ||
              nodeModulesPath.startsWith("mdast") ||
              nodeModulesPath.startsWith("micromark")
            ) {
              return "vendor-markdown";
            }
            if (
              nodeModulesPath.startsWith("react/") ||
              nodeModulesPath.startsWith("react-dom/") ||
              nodeModulesPath.startsWith("scheduler/")
            ) {
              return "vendor-react";
            }

            const segments = nodeModulesPath.split("/");
            const packageName = segments[0]?.startsWith("@")
              ? `${segments[0]}-${segments[1]}`
              : segments[0];
            return `vendor-${sanitizeChunkSegment(packageName ?? "misc")}`;
          },
        },
      },
      sourcemap: buildSourcemap,
    },
  };
}

export default defineConfig(createWebViteConfig());
