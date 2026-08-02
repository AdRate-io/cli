import { readFileSync } from "node:fs"
import { defineConfig } from "vitest/config"

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
  define: {
    __ADRATE_CLI_VERSION__: JSON.stringify(packageJson.version),
  },
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
})
