import { defineConfig } from "tsdown";

const externalNativePackages = new Set(["node-pty", "sqlite3"]);

function isExternalNativePackage(id: string): boolean {
  const [packageName, scopedName] = id.split("/");
  const normalizedName = packageName?.startsWith("@")
    ? `${packageName}/${scopedName ?? ""}`
    : packageName;
  return normalizedName !== undefined && externalNativePackages.has(normalizedName);
}

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm", "cjs"],
  checks: {
    legacyCjs: false,
  },
  outDir: "dist",
  sourcemap: true,
  clean: true,
  // Inject __filename/__dirname shims into the ESM bundle. Native packages that
  // rely on package-relative binding lookup stay external so `bindings` resolves
  // from their installed package directory instead of apps/server.
  shims: true,
  external: [...externalNativePackages],
  noExternal: (id) => !isExternalNativePackage(id) && id.startsWith(""),
  inlineOnly: false,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
