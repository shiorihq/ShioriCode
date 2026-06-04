import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm", "cjs"],
  checks: {
    legacyCjs: false,
  },
  outDir: "dist",
  sourcemap: true,
  clean: true,
  // Inject __filename/__dirname shims into the ESM bundle. The transitively
  // bundled `bindings` package (via node-pty/node-addon-api) references
  // __filename, which is undefined in ESM scope. No-op for the CJS output.
  shims: true,
  noExternal: (id) => id !== "node-pty" && id.startsWith(""),
  inlineOnly: false,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
