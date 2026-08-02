import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Response } from "undici"
import { CLI_VERSION } from "../src/constants.js"
import { createLocalSuccess } from "../src/contracts/envelope.js"
import {
  DefaultUpdateRegistryTransport,
  UPDATE_CACHE_TTL_MS,
  UPDATE_REGISTRY_MAX_BYTES,
  UPDATE_REGISTRY_TIMEOUT_MS,
  UPDATE_REGISTRY_URL,
  UpdateNotifier,
  withUpdateNotifierInspection,
} from "../src/notices/update-notifier.js"
import { createCliPaths } from "../src/storage/paths.js"
import { SecureFileSystem } from "../src/storage/secure-files.js"
import type {
  UpdateFetch,
  UpdateRegistryRequest,
  UpdateRegistryTransport,
} from "../src/notices/update-notifier.js"
import type { CliOutcome } from "../src/errors.js"

const roots: Array<string> = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true }))
  )
})

async function fixture(
  options: {
    now?: Date
    environment?: NodeJS.ProcessEnv
    response?: { status: number; text: string }
    request?: UpdateRegistryTransport["request"]
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "adrate-update-notifier-"))
  roots.push(root)
  await chmod(root, 0o700)
  let now = options.now ?? new Date("2026-08-01T08:00:00.000Z")
  const paths = createCliPaths(root)
  const fileSystem = new SecureFileSystem({ root })
  const request =
    options.request ??
    vi.fn(() =>
      Promise.resolve(options.response ?? { status: 200, text: "{}" })
    )
  const notifier = new UpdateNotifier({
    fileSystem,
    paths,
    environment: options.environment ?? {},
    now: () => now,
    transport: { request },
  })
  return {
    root,
    paths,
    fileSystem,
    request,
    notifier,
    setNow(value: Date) {
      now = value
    },
  }
}

async function writeCache(
  fileSystem: SecureFileSystem,
  paths: ReturnType<typeof createCliPaths>,
  value: string
) {
  await fileSystem.withLock(paths.updateCacheLock, () =>
    fileSystem.atomicWrite(paths.updateCache, value)
  )
}

const requestContract: UpdateRegistryRequest = {
  url: UPDATE_REGISTRY_URL,
  deadlineMs: UPDATE_REGISTRY_TIMEOUT_MS,
  maxResponseBytes: UPDATE_REGISTRY_MAX_BYTES,
  headers: Object.freeze({ accept: "application/json" }),
}

describe("UpdateNotifier", () => {
  it("uses only the fixed anonymous registry request and writes an exact 0600 cache", async () => {
    const now = new Date("2026-08-01T08:00:00.000Z")
    const f = await fixture({
      now,
      response: { status: 200, text: JSON.stringify({ version: "0.2.0" }) },
    })

    const inspection = await f.notifier.inspect()

    expect(f.request).toHaveBeenCalledOnce()
    expect(f.request).toHaveBeenCalledWith(requestContract)
    const sent = vi.mocked(f.request).mock.calls[0]?.[0]
    expect(JSON.stringify(sent)).not.toMatch(/authorization|cookie|token/i)
    expect(inspection).toStrictEqual({
      notice: {
        level: "info",
        currentVersion: CLI_VERSION,
        latestVersion: "0.2.0",
        checkedAt: now.toISOString(),
        suggestedAction: "upgrade_cli",
        command: "npm install -g @adrate/cli",
      },
      warning: `AdRate CLI 0.2.0 is available (current ${CLI_VERSION}). Run: npm install -g @adrate/cli`,
      diagnostic: null,
    })
    expect(
      JSON.parse(await readFile(f.paths.updateCache, "utf8"))
    ).toStrictEqual({
      formatVersion: 1,
      latestVersion: "0.2.0",
      checkedAt: now.toISOString(),
    })
    expect((await stat(f.paths.updateCache)).mode & 0o777).toBe(0o600)
    expect((await stat(f.paths.cacheDirectory)).mode & 0o777).toBe(0o700)
    expect((await readdir(f.paths.cacheDirectory)).sort()).toStrictEqual([
      "update.json",
    ])
  })

  it("reuses a fresh cache for 24 hours and refreshes at the exact TTL", async () => {
    const checkedAt = new Date("2026-08-01T08:00:00.000Z")
    const f = await fixture({
      now: new Date(checkedAt.getTime() + UPDATE_CACHE_TTL_MS - 1),
      response: { status: 200, text: JSON.stringify({ version: "0.3.0" }) },
    })
    await writeCache(
      f.fileSystem,
      f.paths,
      `${JSON.stringify({
        formatVersion: 1,
        latestVersion: "0.2.0",
        checkedAt: checkedAt.toISOString(),
      })}\n`
    )

    expect((await f.notifier.inspect()).notice?.latestVersion).toBe("0.2.0")
    expect(f.request).not.toHaveBeenCalled()

    f.setNow(new Date(checkedAt.getTime() + UPDATE_CACHE_TTL_MS))
    expect((await f.notifier.inspect()).notice?.latestVersion).toBe("0.3.0")
    expect(f.request).toHaveBeenCalledOnce()
  })

  it.each([
    ["same", CLI_VERSION, false],
    ["older", "0.0.9", false],
    ["prerelease below current", "0.1.0-beta.1", false],
    ["new prerelease train", "0.2.0-beta.1", true],
  ])("handles %s semver precedence", async (_label, version, hasNotice) => {
    const f = await fixture({
      response: { status: 200, text: JSON.stringify({ version }) },
    })
    expect(Boolean((await f.notifier.inspect()).notice)).toBe(hasNotice)
  })

  it.each([
    ["non-2xx", () => Promise.resolve({ status: 503, text: "{}" })],
    ["invalid JSON", () => Promise.resolve({ status: 200, text: "{bad" })],
    [
      "invalid semver",
      () =>
        Promise.resolve({
          status: 200,
          text: JSON.stringify({ version: "latest" }),
        }),
    ],
    ["network", () => Promise.reject(new Error("secret details"))],
  ])(
    "omits the notice on %s without exposing transport details",
    async (_label, request) => {
      const f = await fixture({ request })
      const inspection = await f.notifier.inspect()
      expect(inspection.notice).toBeNull()
      expect(inspection.warning).toBeNull()
      expect(inspection.diagnostic).toMatch(/^Update check skipped/)
      expect(inspection.diagnostic).not.toContain("secret details")
      await expect(f.fileSystem.exists(f.paths.updateCache)).resolves.toBe(
        false
      )
    }
  )

  it("treats corrupt, future, and unsafe caches as fail-closed local state", async () => {
    const corrupt = await fixture({
      response: { status: 200, text: JSON.stringify({ version: "9.0.0" }) },
    })
    await writeCache(corrupt.fileSystem, corrupt.paths, "{bad\n")
    expect((await corrupt.notifier.inspect()).diagnostic).toContain("invalid")
    expect(corrupt.request).not.toHaveBeenCalled()

    const future = await fixture({
      response: { status: 200, text: JSON.stringify({ version: "0.2.0" }) },
    })
    await writeCache(
      future.fileSystem,
      future.paths,
      `${JSON.stringify({
        formatVersion: 1,
        latestVersion: "0.2.0",
        checkedAt: "2026-08-02T08:00:00.000Z",
      })}\n`
    )
    expect((await future.notifier.inspect()).notice?.latestVersion).toBe(
      "0.2.0"
    )
    expect(future.request).toHaveBeenCalledOnce()

    const unsafe = await fixture({
      response: { status: 200, text: JSON.stringify({ version: "9.0.0" }) },
    })
    await unsafe.fileSystem.ensureDirectory(unsafe.paths.cacheDirectory)
    const outside = join(unsafe.root, "outside.json")
    await writeFile(outside, "{}\n", { mode: 0o600 })
    await symlink(outside, unsafe.paths.updateCache)
    expect((await unsafe.notifier.inspect()).diagnostic).toContain("unsafe")
    expect(unsafe.request).not.toHaveBeenCalled()
  })

  it("suppresses all cache and network work with only the update switch", async () => {
    const readSecureFile = vi.fn(() =>
      Promise.reject(new Error("must not read"))
    )
    const request = vi.fn(() => Promise.reject(new Error("must not request")))
    const notifier = new UpdateNotifier({
      fileSystem: { readSecureFile } as unknown as SecureFileSystem,
      paths: createCliPaths("/tmp/adrate-update-suppressed"),
      environment: {
        ADRATE_NO_UPDATE_NOTIFIER: "1",
        ADRATE_NO_SKILLS_NOTIFIER: "0",
      },
      transport: { request },
    })

    await expect(notifier.inspect()).resolves.toStrictEqual({
      notice: null,
      warning: null,
      diagnostic: null,
    })
    expect(readSecureFile).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it("merges update beside credential/skills and emits diagnostics only in verbose mode", () => {
    const base: CliOutcome = {
      exitCode: 4,
      envelope: createLocalSuccess(
        "update_merge",
        { value: true },
        {
          _notice: {
            credential: { level: "warning" },
            skills: { level: "warning" },
            update: { level: "untrusted" },
          },
        }
      ),
      warnings: ["core-warning"],
    }
    const inspection = {
      notice: null,
      warning: null,
      diagnostic: "Update check skipped after a timeout failure.",
    }

    const quiet = withUpdateNotifierInspection(base, inspection, false)
    expect(quiet.exitCode).toBe(4)
    expect(quiet.envelope.meta._notice).toStrictEqual({
      credential: { level: "warning" },
      skills: { level: "warning" },
    })
    expect(quiet.warnings).toStrictEqual(["core-warning"])

    expect(
      withUpdateNotifierInspection(base, inspection, true).warnings
    ).toStrictEqual([
      "core-warning",
      "Update check skipped after a timeout failure.",
    ])
  })
})

describe("DefaultUpdateRegistryTransport", () => {
  it("enforces the 2 second deadline across the whole request", async () => {
    vi.useFakeTimers()
    const requestUrl = vi.fn(
      (_url: unknown, init: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const error = new Error("aborted")
            error.name = "AbortError"
            reject(error)
          })
        })
    )
    const pending = new DefaultUpdateRegistryTransport(
      requestUrl as unknown as UpdateFetch
    ).request(requestContract)
    const rejected = expect(pending).rejects.toMatchObject({ kind: "timeout" })
    await vi.advanceTimersByTimeAsync(UPDATE_REGISTRY_TIMEOUT_MS)
    await rejected
  })

  it("rejects redirects, over-sized bodies, and any widened request contract", async () => {
    const redirect = new DefaultUpdateRegistryTransport(
      vi.fn(() =>
        Promise.resolve(new Response(null, { status: 302 }))
      ) as unknown as UpdateFetch
    )
    await expect(redirect.request(requestContract)).rejects.toMatchObject({
      kind: "invalid_response",
    })

    const oversized = new DefaultUpdateRegistryTransport(
      vi.fn(() =>
        Promise.resolve(new Response("x".repeat(UPDATE_REGISTRY_MAX_BYTES + 1)))
      ) as unknown as UpdateFetch
    )
    await expect(oversized.request(requestContract)).rejects.toMatchObject({
      kind: "invalid_response",
    })

    await expect(
      oversized.request({
        ...requestContract,
        headers: { accept: "application/json", authorization: "secret" },
      } as unknown as UpdateRegistryRequest)
    ).rejects.toMatchObject({ kind: "invalid_response" })
  })
})
