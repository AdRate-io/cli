import { readFileSync } from "node:fs"
import { defineConfig } from "tsup"

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
) as { version?: unknown }

if (
  typeof packageJson.version !== "string" ||
  packageJson.version.length === 0
) {
  throw new Error("cli/package.json must contain a non-empty version.")
}

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  dts: true,
  sourcemap: true,
  esbuildOptions(options) {
    options.sourcesContent = false
  },
  clean: true,
  splitting: true,
  treeshake: true,
  external: ["@github/keytar"],
  define: {
    __ADRATE_CLI_VERSION__: JSON.stringify(packageJson.version),
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
})
