import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/bin.tsx"],
  format: ["esm"],
  checks: {
    legacyCjs: false,
  },
  outDir: "dist",
  sourcemap: true,
  clean: true,
  noExternal: (id) => id.startsWith(""),
  inlineOnly: false,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
