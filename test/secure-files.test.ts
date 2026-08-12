import {
  appendFile,
  chmod,
  lstat,
  lutimes,
  mkdir,
  open,
  readdir,
  rename,
  symlink,
  truncate,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { Buffer } from "node:buffer"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  SecureFileError,
  SecureFileLockBusyError,
  SecureFileSystem,
} from "../src/storage/secure-files.js"
import { CliStateStore } from "../src/storage/state-store.js"
import { createTemporaryStateFixture, deferred } from "./helpers.js"
import type { TemporaryStateFixture } from "./helpers.js"

let fixture: TemporaryStateFixture | null = null
const describePosix = process.platform === "win32" ? describe.skip : describe

afterEach(async () => {
  if (fixture) await fixture.cleanup()
  fixture = null
})

describe("SecureFileSystem create-if-absent platform contract", () => {
  it("uses no-replace publication on the Windows ACL code path", async () => {
    fixture = await createTemporaryStateFixture()
    const aclCalls: Array<string> = []
    const fileSystem = new SecureFileSystem({
      root: fixture.root,
      platform: "win32",
      windowsAcl: {
        async ensureDirectory(path) {
          await mkdir(path, { recursive: true })
          aclCalls.push(`directory:${path}`)
        },
        secure(path, kind) {
          aclCalls.push(`secure:${kind}:${path}`)
          return Promise.resolve()
        },
        async verify(path, kind) {
          const info = await lstat(path)
          return kind === "file" ? info.isFile() : info.isDirectory()
        },
        async atomicReplace(source, target) {
          await rename(source, target)
        },
      },
    })
    const target = join(fixture.root, "pending", "windows.json")

    await expect(fileSystem.atomicCreate(target, "first\n")).resolves.toBe(
      "created"
    )
    await expect(fileSystem.atomicCreate(target, "second\n")).resolves.toBe(
      "exists"
    )

    expect(await fileSystem.readSecureFile(target)).toBe("first\n")
    expect(aclCalls.some((call) => call.startsWith("secure:file:"))).toBe(true)
  })
})

describePosix("SecureFileSystem POSIX security boundary", () => {
  it("accepts the exact local file limit and rejects limit plus one", async () => {
    fixture = await createTemporaryStateFixture()
    await fixture.fileSystem.ensureRoot()
    const exact = join(fixture.root, "exact-limit")
    const oversized = join(fixture.root, "over-limit")
    await writeFile(exact, Buffer.alloc(1024 * 1024, 0x61), { mode: 0o600 })
    await writeFile(oversized, Buffer.alloc(1024 * 1024 + 1, 0x61), {
      mode: 0o600,
    })

    expect((await fixture.fileSystem.readSecureFile(exact))?.length).toBe(
      1024 * 1024
    )
    await expect(fixture.fileSystem.readSecureFile(oversized)).rejects.toThrow(
      "too large"
    )
  })

  it("bounds a same-inode growth race instead of reading to an unbounded EOF", async () => {
    fixture = await createTemporaryStateFixture()
    await fixture.fileSystem.ensureRoot()
    const target = join(fixture.root, "growing")
    await writeFile(target, "a", { mode: 0o600 })
    const racing = new SecureFileSystem({
      root: fixture.root,
      testHooks: {
        afterReadFileOpened: () =>
          appendFile(target, Buffer.alloc(1024 * 1024 + 1, 0x62)),
      },
    })

    await expect(racing.readSecureFile(target)).rejects.toThrow("too large")
  })

  it("rejects truncation and path replacement after the secure handle opens", async () => {
    fixture = await createTemporaryStateFixture()
    await fixture.fileSystem.ensureRoot()
    const truncated = join(fixture.root, "truncated")
    await writeFile(truncated, "original", { mode: 0o600 })
    const truncating = new SecureFileSystem({
      root: fixture.root,
      testHooks: { afterReadFileOpened: () => truncate(truncated, 1) },
    })
    await expect(truncating.readSecureFile(truncated)).rejects.toThrow(
      "changed while it was being read"
    )

    const replaced = join(fixture.root, "replaced")
    await writeFile(replaced, "old", { mode: 0o600 })
    const replacing = new SecureFileSystem({
      root: fixture.root,
      testHooks: {
        async afterReadFileOpened() {
          await rename(replaced, `${replaced}.old`)
          await writeFile(replaced, "new", { mode: 0o600 })
        },
      },
    })
    await expect(replacing.readSecureFile(replaced)).rejects.toThrow(
      "changed while it was being read"
    )
  })

  it("rejects same-inode growth in the handle-restat to path-restat window", async () => {
    fixture = await createTemporaryStateFixture()
    await fixture.fileSystem.ensureRoot()
    const target = join(fixture.root, "late-growth")
    await writeFile(target, "stable", { mode: 0o600 })
    const racing = new SecureFileSystem({
      root: fixture.root,
      testHooks: {
        afterReadHandleRestat: () => appendFile(target, "changed"),
      },
    })

    await expect(racing.readSecureFile(target)).rejects.toThrow(
      "changed while it was being read"
    )
  })

  it("publishes complete files with atomic create-if-absent and never overwrites", async () => {
    fixture = await createTemporaryStateFixture()
    const target = join(fixture.root, "pending", "record.json")

    await expect(
      fixture.fileSystem.atomicCreate(target, '{"writer":1}\n')
    ).resolves.toBe("created")
    await expect(
      fixture.fileSystem.atomicCreate(target, '{"writer":2}\n')
    ).resolves.toBe("exists")

    expect(await fixture.fileSystem.readSecureFile(target)).toBe(
      '{"writer":1}\n'
    )
    expect((await lstat(target)).mode & 0o777).toBe(0o600)
    expect((await lstat(dirname(target))).mode & 0o777).toBe(0o700)
    expect(
      (await readdir(dirname(target))).filter((name) => name.includes(".tmp-"))
    ).toEqual([])
  })

  it("allows exactly one concurrent create-if-absent publisher", async () => {
    fixture = await createTemporaryStateFixture()
    const target = join(fixture.root, "pending", "race.json")
    const peer = new SecureFileSystem({ root: fixture.root })

    const results = await Promise.all([
      fixture.fileSystem.atomicCreate(target, '{"writer":"a"}\n'),
      peer.atomicCreate(target, '{"writer":"b"}\n'),
    ])

    expect([...results].sort()).toEqual(["created", "exists"])
    expect(['{"writer":"a"}\n', '{"writer":"b"}\n']).toContain(
      await fixture.fileSystem.readSecureFile(target)
    )
  })

  it("keeps the complete target and no temp residue when post-link directory fsync fails", async () => {
    fixture = await createTemporaryStateFixture()
    const target = join(fixture.root, "pending", "durability.json")
    const internals = fixture.fileSystem as unknown as {
      syncDirectory: (path: string) => Promise<void>
    }
    const originalSyncDirectory = internals.syncDirectory.bind(
      fixture.fileSystem
    )
    let injected = false
    internals.syncDirectory = (path) => {
      if (!injected && path === dirname(target)) {
        injected = true
        return Promise.reject(new Error("injected directory fsync failure"))
      }
      return originalSyncDirectory(path)
    }

    try {
      await expect(
        fixture.fileSystem.atomicCreate(target, "durable-candidate\n")
      ).rejects.toThrow("injected directory fsync failure")
    } finally {
      internals.syncDirectory = originalSyncDirectory
    }

    expect(await fixture.fileSystem.readSecureFile(target)).toBe(
      "durable-candidate\n"
    )
    expect(
      (await readdir(dirname(target))).filter((name) => name.includes(".tmp-"))
    ).toEqual([])
    await expect(
      fixture.fileSystem.atomicCreate(target, "must-not-overwrite\n")
    ).resolves.toBe("exists")
    expect(await fixture.fileSystem.readSecureFile(target)).toBe(
      "durable-candidate\n"
    )
  })

  it("rejects an unsafe existing create-if-absent target", async () => {
    fixture = await createTemporaryStateFixture()
    await fixture.fileSystem.ensureRoot()
    const outside = join(fixture.parent, "outside.json")
    const target = join(fixture.root, "pending.json")
    await writeFile(outside, "outside\n", { mode: 0o600 })
    await symlink(outside, target)

    await expect(
      fixture.fileSystem.atomicCreate(target, "inside\n")
    ).rejects.toThrow("unsafe")
    expect((await lstat(outside)).isFile()).toBe(true)
  })

  it("creates the state tree as 0700 and files as 0600", async () => {
    fixture = await createTemporaryStateFixture()
    const target = join(fixture.root, "nested", "state.json")

    await fixture.fileSystem.atomicWrite(target, '{"ok":true}\n')

    expect((await lstat(fixture.root)).mode & 0o777).toBe(0o700)
    expect((await lstat(dirname(target))).mode & 0o777).toBe(0o700)
    expect((await lstat(target)).mode & 0o777).toBe(0o600)
    expect(await fixture.fileSystem.readSecureFile(target)).toBe(
      '{"ok":true}\n'
    )
  })

  it("rejects an existing state directory with broader permissions", async () => {
    fixture = await createTemporaryStateFixture()
    await mkdir(fixture.root, { mode: 0o755 })
    await chmod(fixture.root, 0o755)

    await expect(fixture.fileSystem.ensureRoot()).rejects.toThrow(
      "permissions must be 700"
    )
  })

  it("rejects an existing file with broader permissions", async () => {
    fixture = await createTemporaryStateFixture()
    await fixture.fileSystem.ensureRoot()
    const target = join(fixture.root, "broad.json")
    await writeFile(target, "{}\n", { mode: 0o644 })
    await chmod(target, 0o644)

    await expect(fixture.fileSystem.readSecureFile(target)).rejects.toThrow(
      "permissions must be 600"
    )
    await expect(
      fixture.fileSystem.atomicWrite(target, '{"changed":true}\n')
    ).rejects.toThrow("permissions must be 600")
  })

  it("rejects a symlink in an intermediate directory", async () => {
    fixture = await createTemporaryStateFixture()
    await fixture.fileSystem.ensureRoot()
    const outside = join(fixture.parent, "outside")
    await mkdir(outside, { mode: 0o700 })
    await symlink(outside, join(fixture.root, "linked"))

    await expect(
      fixture.fileSystem.atomicWrite(
        join(fixture.root, "linked", "secret"),
        "blocked"
      )
    ).rejects.toThrow(SecureFileError)
  })

  it("rejects a symlink target for read, replace, and removal", async () => {
    fixture = await createTemporaryStateFixture()
    await fixture.fileSystem.ensureRoot()
    const outside = join(fixture.parent, "outside-secret")
    await writeFile(outside, "outside", { mode: 0o600 })
    const target = join(fixture.root, "token")
    await symlink(outside, target)

    await expect(fixture.fileSystem.readSecureFile(target)).rejects.toThrow(
      "symbolic link"
    )
    await expect(
      fixture.fileSystem.atomicWrite(target, "replacement")
    ).rejects.toThrow("symbolic link")
    await expect(fixture.fileSystem.removeSecureFile(target)).rejects.toThrow(
      "symbolic link"
    )
  })

  it("uses same-directory create-exclusive temporary files and leaves no residue", async () => {
    fixture = await createTemporaryStateFixture()
    const target = join(fixture.root, "device-authorizations", "current.json")

    await fixture.fileSystem.atomicWrite(target, "first")
    await fixture.fileSystem.atomicWrite(target, "second")

    expect(await fixture.fileSystem.readSecureFile(target)).toBe("second")
    expect(await readdir(dirname(target))).toEqual(["current.json"])
  })

  it("rejects oversized writes and oversized existing files", async () => {
    fixture = await createTemporaryStateFixture()
    const target = join(fixture.root, "large")
    const oversized = "x".repeat(1024 * 1024 + 1)

    await expect(
      fixture.fileSystem.atomicWrite(target, oversized)
    ).rejects.toThrow("too large")

    await fixture.fileSystem.ensureRoot()
    await writeFile(target, oversized, { mode: 0o600 })
    await chmod(target, 0o600)
    await expect(fixture.fileSystem.readSecureFile(target)).rejects.toThrow(
      "too large"
    )
  })

  it("rejects invalid UTF-8 in local JSON instead of accepting replacement characters", async () => {
    fixture = await createTemporaryStateFixture()
    await fixture.fileSystem.ensureRoot()
    await writeFile(
      fixture.paths.config,
      Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d]),
      { mode: 0o600 }
    )
    await chmod(fixture.paths.config, 0o600)
    const state = new CliStateStore(fixture.fileSystem, fixture.paths)

    await expect(state.readConfig()).rejects.toThrow("not valid UTF-8")
  })
})


describePosix("SecureFileSystem minimal local lock", () => {
  it("serializes concurrent owners and releases the lock after completion", async () => {
    fixture = await createTemporaryStateFixture()
    const lock = fixture.paths.authLock
    const entered = deferred()
    const release = deferred()
    const first = fixture.fileSystem.withLock(lock, async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise

    await expect(
      fixture.fileSystem.withLock(lock, () => Promise.resolve(undefined))
    ).rejects.toBeInstanceOf(SecureFileLockBusyError)

    release.resolve()
    await first
    await expect(
      fixture.fileSystem.withLock(lock, () => Promise.resolve("acquired"))
    ).resolves.toBe("acquired")
    expect(await fixture.fileSystem.exists(lock)).toBe(false)
  })

  it("treats a fresh foreign lock as busy and leaves it in place", async () => {
    fixture = await createTemporaryStateFixture()
    const lock = fixture.paths.authLock
    await fixture.fileSystem.atomicWrite(lock, "")

    await expect(
      fixture.fileSystem.withLock(lock, () => Promise.resolve("unexpected"))
    ).rejects.toBeInstanceOf(SecureFileLockBusyError)
    expect(await fixture.fileSystem.exists(lock)).toBe(true)

    await fixture.fileSystem.removeSecureFile(lock)
    await expect(
      fixture.fileSystem.withLock(lock, () => Promise.resolve("acquired"))
    ).resolves.toBe("acquired")
  })

  it("reclaims an orphan lock left behind by a killed process", async () => {
    fixture = await createTemporaryStateFixture()
    const lock = fixture.paths.authLock
    await fixture.fileSystem.atomicWrite(lock, "")
    const orphanAge = new Date(Date.now() - 60_000)
    await utimes(lock, orphanAge, orphanAge)

    await expect(
      fixture.fileSystem.withLock(lock, () => Promise.resolve("recovered"))
    ).resolves.toBe("recovered")
    expect(await fixture.fileSystem.exists(lock)).toBe(false)
  })

  it("does not reclaim a stale non-regular file at the lock path", async () => {
    fixture = await createTemporaryStateFixture()
    await fixture.fileSystem.ensureRoot()
    const lock = fixture.paths.authLock
    const decoy = join(fixture.root, "decoy")
    await writeFile(decoy, "", { mode: 0o600 })
    await symlink(decoy, lock)
    const orphanAge = new Date(Date.now() - 60_000)
    await lutimes(lock, orphanAge, orphanAge)

    await expect(
      fixture.fileSystem.withLock(lock, () => Promise.resolve("unexpected"))
    ).rejects.toBeInstanceOf(SecureFileLockBusyError)
    expect((await lstat(lock)).isSymbolicLink()).toBe(true)
  })
})
