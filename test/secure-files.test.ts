import {
  appendFile,
  chmod,
  link,
  lstat,
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
import { SecureFileLockCoordinator } from "../src/storage/secure-file-lock.js"
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

describePosix("SecureFileSystem fenced local lock", () => {
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

  it("reclaims only a valid stale lock whose pid probe returns ESRCH", async () => {
    const now = Date.parse("2026-07-31T08:10:00.000Z")
    fixture = await createTemporaryStateFixture()
    const deadPid = 2_000_000_000
    const fileSystem = new SecureFileSystem({
      root: fixture.root,
      platform: process.platform,
      now: () => now,
      lockStaleAfterMs: 60_000,
      processSignal(pid) {
        expect(pid).toBe(deadPid)
        throw Object.assign(new Error("dead"), { code: "ESRCH" })
      },
    })
    await fixture.fileSystem.ensureRoot()
    const lock = fixture.paths.authLock
    const staleAt = "2026-07-31T08:00:00.000Z"
    await fixture.fileSystem.atomicWrite(
      lock,
      `${JSON.stringify({
        formatVersion: 1,
        pid: deadPid,
        ownerToken: "44444444-4444-4444-8444-444444444444",
        createdAt: staleAt,
      })}\n`
    )
    const staleSeconds = Date.parse(staleAt) / 1000
    await utimes(lock, staleSeconds, staleSeconds)

    await expect(
      fileSystem.withLock(lock, () => Promise.resolve("recovered"))
    ).resolves.toBe("recovered")

    const names = await readdir(fixture.root)
    expect(names.some((name) => name.includes(".stale-"))).toBe(false)
    expect(names).not.toContain(".auth.lock")
  })

  it("does not reclaim a live owner even when the stale timeout is zero", async () => {
    fixture = await createTemporaryStateFixture({
      lockStaleAfterMs: 0,
    })
    const lock = fixture.paths.authLock
    const entered = deferred()
    const release = deferred()

    const first = fixture.fileSystem.withLock(lock, async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise

    await expect(
      fixture.fileSystem.withLock(lock, () => Promise.resolve("unexpected"))
    ).rejects.toBeInstanceOf(SecureFileLockBusyError)
    expect(await fixture.fileSystem.exists(lock)).toBe(true)

    release.resolve()
    await first
    expect(await fixture.fileSystem.exists(lock)).toBe(false)
  })

  it("treats EPERM and malformed stale records as busy, never as proof of death", async () => {
    const now = Date.parse("2026-07-31T08:10:00.000Z")
    fixture = await createTemporaryStateFixture()
    const deniedFileSystem = new SecureFileSystem({
      root: fixture.root,
      platform: process.platform,
      now: () => now,
      lockStaleAfterMs: 0,
      processSignal() {
        throw Object.assign(new Error("denied"), { code: "EPERM" })
      },
    })
    await fixture.fileSystem.ensureRoot()
    await fixture.fileSystem.atomicWrite(
      fixture.paths.authLock,
      `${JSON.stringify({
        formatVersion: 1,
        pid: 1234,
        ownerToken: "55555555-5555-4555-8555-555555555555",
        createdAt: "2026-07-31T08:00:00.000Z",
      })}\n`
    )

    await expect(
      deniedFileSystem.withLock(fixture.paths.authLock, () =>
        Promise.resolve("unexpected")
      )
    ).rejects.toBeInstanceOf(SecureFileLockBusyError)

    await fixture.fileSystem.removeSecureFile(fixture.paths.authLock)
    const handle = await open(fixture.paths.authLock, "wx", 0o600)
    await handle.writeFile("{}\n", "utf8")
    await handle.close()
    await chmod(fixture.paths.authLock, 0o600)
    const staleSeconds = (now - 2 * 60_000) / 1000
    await utimes(fixture.paths.authLock, staleSeconds, staleSeconds)

    await expect(
      deniedFileSystem.withLock(fixture.paths.authLock, () =>
        Promise.resolve("recovered")
      )
    ).rejects.toBeInstanceOf(SecureFileLockBusyError)
  })

  it("never lets a reclaimer that inspected I0 delete or fence a later I1 owner", async () => {
    const now = Date.parse("2026-07-31T08:10:00.000Z")
    fixture = await createTemporaryStateFixture()
    await fixture.fileSystem.ensureRoot()
    const lock = fixture.paths.authLock
    const protectedWrite = join(fixture.root, "protected-write.json")
    await fixture.fileSystem.atomicWrite(
      lock,
      `${JSON.stringify({
        formatVersion: 1,
        pid: 2_000_000_000,
        ownerToken: "66666666-6666-4666-8666-666666666666",
        createdAt: "2026-07-31T08:00:00.000Z",
      })}\n`
    )

    const probeEntered = deferred()
    const releaseProbe = deferred()
    const recovering = new SecureFileSystem({
      root: fixture.root,
      platform: process.platform,
      now: () => now,
      lockStaleAfterMs: 0,
      async processSignal() {
        probeEntered.resolve()
        await releaseProbe.promise
        throw Object.assign(new Error("dead"), { code: "ESRCH" })
      },
    })
    const displaced = new SecureFileSystem({
      root: fixture.root,
      platform: process.platform,
      now: () => now,
      lockStaleAfterMs: 0,
    })
    const third = new SecureFileSystem({
      root: fixture.root,
      platform: process.platform,
      now: () => now,
      lockStaleAfterMs: 0,
    })

    const recoveryAttempt = recovering.withLock(lock, () =>
      Promise.resolve("unexpected")
    )
    await probeEntered.promise
    await rename(lock, `${lock}.dead-candidate`)

    const displacedEntered = deferred()
    const releaseDisplaced = deferred()
    const displacedOwner = displaced.withLock(lock, async () => {
      displacedEntered.resolve()
      await releaseDisplaced.promise
    })
    await displacedEntered.promise

    releaseProbe.resolve()
    await expect(recoveryAttempt).rejects.toBeInstanceOf(
      SecureFileLockBusyError
    )

    await displaced.atomicWrite(protectedWrite, "new-owner")
    await expect(
      third.withLock(lock, () => Promise.resolve("unexpected"))
    ).rejects.toBeInstanceOf(SecureFileLockBusyError)
    expect(await third.exists(lock)).toBe(true)
    expect(await third.readSecureFile(protectedWrite)).toBe("new-owner")

    releaseDisplaced.resolve()
    await displacedOwner
    await expect(
      third.withLock(lock, () => Promise.resolve("third"))
    ).resolves.toBe("third")
    expect(await third.exists(lock)).toBe(false)
    const names = await readdir(fixture.root)
    expect(names.filter((name) => name.includes(".reclaim-"))).toHaveLength(0)
  })

  it("cleans its claim when it hard-links a provisional I1 whose record is incomplete", async () => {
    const now = Date.parse("2026-07-31T08:10:00.000Z")
    fixture = await createTemporaryStateFixture()
    await fixture.fileSystem.ensureRoot()
    const lock = fixture.paths.authLock
    await fixture.fileSystem.atomicWrite(
      lock,
      `${JSON.stringify({
        formatVersion: 1,
        pid: 2_000_000_000,
        ownerToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        createdAt: "2026-07-31T08:00:00.000Z",
      })}\n`
    )
    const probeEntered = deferred()
    const releaseProbe = deferred()
    const recovering = new SecureFileSystem({
      root: fixture.root,
      platform: process.platform,
      now: () => now,
      lockStaleAfterMs: 0,
      async processSignal() {
        probeEntered.resolve()
        await releaseProbe.promise
        throw Object.assign(new Error("dead"), { code: "ESRCH" })
      },
    })

    const recovery = recovering.withLock(lock, () =>
      Promise.resolve("unexpected")
    )
    await probeEntered.promise
    await rename(lock, `${lock}.old-I0`)
    const provisional = await open(lock, "wx", 0o600)
    await provisional.writeFile('{"formatVersion":1', "utf8")
    await provisional.sync()
    await provisional.close()
    await chmod(lock, 0o600)
    const provisionalIdentity = await lstat(lock)

    releaseProbe.resolve()
    await expect(recovery).rejects.toBeInstanceOf(SecureFileLockBusyError)
    const after = await lstat(lock)
    expect({ dev: after.dev, ino: after.ino }).toEqual({
      dev: provisionalIdentity.dev,
      ino: provisionalIdentity.ino,
    })
    expect(await recovering.readSecureFile(lock)).toBe('{"formatVersion":1')
    expect(
      (await readdir(fixture.root)).filter((name) => name.includes(".reclaim-"))
    ).toHaveLength(0)
  })

  it.each([
    ["cleans the exact two-piece evidence", false],
    [
      "preserves the complete two-piece evidence when cleanup is uncertain",
      true,
    ],
  ] as const)(
    "%s after link succeeds but directory sync fails",
    async (_label, cleanupUncertain) => {
      const now = Date.parse("2026-07-31T08:10:00.000Z")
      fixture = await createTemporaryStateFixture()
      await fixture.fileSystem.ensureRoot()
      const lock = fixture.paths.authLock
      const oldContent = `${JSON.stringify({
        formatVersion: 1,
        pid: 2_000_000_000,
        ownerToken: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        createdAt: "2026-07-31T08:00:00.000Z",
      })}\n`
      await fixture.fileSystem.atomicWrite(lock, oldContent)
      const oldIdentity = await lstat(lock)
      let syncCalls = 0
      const coordinator = new SecureFileLockCoordinator({
        now: () => now,
        platform: process.platform,
        staleAfterMs: 0,
        processSignal() {
          throw Object.assign(new Error("dead"), { code: "ESRCH" })
        },
        processIdentity: {
          current: () =>
            Promise.resolve({ pid: process.pid, fingerprint: "test:current" }),
          inspect: () => Promise.resolve("dead"),
        },
        operations: {
          assertContained: (path) => path,
          ensureDirectory: () => Promise.resolve(),
          verifyFile: () => Promise.resolve(),
          verifyDirectoryChain: () => Promise.resolve(),
          verifyResolvedParent: () => Promise.resolve(),
          secureCreatedFile: (path) => chmod(path, 0o600),
          syncDirectory: () => {
            syncCalls += 1
            return syncCalls === 2
              ? Promise.reject(
                  new Error("injected link directory sync failure")
                )
              : Promise.resolve()
          },
          async readFileIdentity(path) {
            const info = await lstat(path)
            return { device: info.dev, inode: info.ino }
          },
          async assertFileIdentity(path, expected) {
            if (cleanupUncertain && path.includes(".reclaim-")) {
              throw new Error("injected cleanup uncertainty")
            }
            const info = await lstat(path)
            expect({ device: info.dev, inode: info.ino }).toEqual(expected)
          },
          busyError: () => new SecureFileLockBusyError(),
        },
      })

      await expect(
        coordinator.withLock(lock, () => Promise.resolve("unexpected"))
      ).rejects.toBeInstanceOf(SecureFileLockBusyError)
      const after = await lstat(lock)
      expect({ dev: after.dev, ino: after.ino }).toEqual({
        dev: oldIdentity.dev,
        ino: oldIdentity.ino,
      })
      expect(await fixture.fileSystem.readSecureFile(lock)).toBe(oldContent)
      const evidence = (await readdir(fixture.root)).filter((name) =>
        name.includes(".reclaim-")
      )
      expect(evidence).toHaveLength(cleanupUncertain ? 2 : 0)
      if (cleanupUncertain) {
        expect(evidence.filter((name) => name.endsWith(".lock"))).toHaveLength(
          1
        )
        expect(evidence.filter((name) => name.endsWith(".json"))).toHaveLength(
          1
        )
      }
    }
  )

  it("blocks a target commit when a hard-link claim appears after callback activation", async () => {
    fixture = await createTemporaryStateFixture()
    const lock = fixture.paths.authLock
    const target = join(fixture.root, "claimed-write.json")
    const entered = deferred()
    const attemptWrite = deferred()
    const writeChecked = deferred()
    const release = deferred()
    const owner = fixture.fileSystem.withLock(lock, async () => {
      entered.resolve()
      await attemptWrite.promise
      await expect(
        fixture!.fileSystem.atomicWrite(target, "must-not-commit")
      ).rejects.toBeInstanceOf(SecureFileLockBusyError)
      writeChecked.resolve()
      await release.promise
    })
    await entered.promise

    const identity = await lstat(lock)
    const claimToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    const claim = `${lock}.reclaim-${claimToken}.lock`
    const manifest = `${lock}.reclaim-${claimToken}.json`
    await fixture.fileSystem.atomicWrite(
      manifest,
      `${JSON.stringify({
        formatVersion: 1,
        claimToken,
        reclaimerPid: process.pid,
        reclaimerProcessFingerprint: "test:active-reclaimer",
        expectedDevice: identity.dev,
        expectedInode: identity.ino,
        createdAt: new Date().toISOString(),
      })}\n`
    )
    await link(lock, claim)
    attemptWrite.resolve()
    await writeChecked.promise
    expect(await fixture.fileSystem.exists(target)).toBe(false)

    await unlink(claim)
    await unlink(manifest)
    release.resolve()
    await owner
    expect(await fixture.fileSystem.exists(lock)).toBe(false)
  })

  it.each([
    ["after hard-link claim", true, true],
    ["after canonical unlink and before claim cleanup", false, true],
    ["after claim cleanup and before manifest cleanup", false, false],
  ] as const)(
    "recovers a crashed reclaimer %s without touching a later generation",
    async (_phase, keepCanonical, keepClaim) => {
      const now = Date.parse("2026-07-31T08:10:00.000Z")
      fixture = await createTemporaryStateFixture()
      await fixture.fileSystem.ensureRoot()
      const lock = fixture.paths.authLock
      const oldOwnerPid = 2_000_000_000
      const deadReclaimerPid = 2_000_000_001
      const claimToken = "77777777-7777-4777-8777-777777777777"
      const staleAt = "2026-07-31T08:00:00.000Z"
      await fixture.fileSystem.atomicWrite(
        lock,
        `${JSON.stringify({
          formatVersion: 1,
          pid: oldOwnerPid,
          ownerToken: "66666666-6666-4666-8666-666666666666",
          createdAt: staleAt,
        })}\n`
      )
      const identity = await lstat(lock)
      const claim = `${lock}.reclaim-${claimToken}.lock`
      const manifest = `${lock}.reclaim-${claimToken}.json`
      await fixture.fileSystem.atomicWrite(
        manifest,
        `${JSON.stringify({
          formatVersion: 1,
          claimToken,
          reclaimerPid: deadReclaimerPid,
          reclaimerProcessFingerprint: "test:dead-reclaimer",
          expectedDevice: identity.dev,
          expectedInode: identity.ino,
          createdAt: staleAt,
        })}\n`
      )
      if (keepClaim) await link(lock, claim)
      if (!keepCanonical) await unlink(lock)

      const recovered = new SecureFileSystem({
        root: fixture.root,
        platform: process.platform,
        now: () => now,
        lockStaleAfterMs: 60_000,
        processSignal(pid) {
          expect(pid).toBe(oldOwnerPid)
          throw Object.assign(new Error("dead"), { code: "ESRCH" })
        },
        processIdentity: {
          current: () =>
            Promise.resolve({ pid: process.pid, fingerprint: "test:current" }),
          inspect(expected) {
            expect(expected).toEqual({
              pid: deadReclaimerPid,
              fingerprint: "test:dead-reclaimer",
            })
            return Promise.resolve("dead")
          },
        },
      })

      await expect(
        recovered.withLock(lock, () => Promise.resolve("recovered"))
      ).resolves.toBe("recovered")
      expect(await recovered.exists(lock)).toBe(false)
      expect(
        (await readdir(fixture.root)).filter((name) =>
          name.includes(".reclaim-")
        )
      ).toHaveLength(0)
    }
  )

  it.each([
    ["fresh", "matching", "2026-07-31T08:10:00.000Z"],
    ["malformed", "malformed", "2026-07-31T08:00:00.000Z"],
    ["token-mismatched", "mismatched", "2026-07-31T08:00:00.000Z"],
  ] as const)(
    "does not treat a %s manifest-only record as a canonical inode barrier",
    async (_label, manifestKind, createdAt) => {
      const now = Date.parse("2026-07-31T08:10:00.000Z")
      fixture = await createTemporaryStateFixture({
        lockStaleAfterMs: 60_000,
      })
      await fixture.fileSystem.ensureRoot()
      const lock = fixture.paths.authLock
      const fileToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      const payloadToken =
        manifestKind === "mismatched"
          ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
          : fileToken
      const manifest = `${lock}.reclaim-${fileToken}.json`
      await fixture.fileSystem.atomicWrite(
        manifest,
        manifestKind === "malformed"
          ? "{}\n"
          : `${JSON.stringify({
              formatVersion: 1,
              claimToken: payloadToken,
              reclaimerPid: 2_000_000_001,
              reclaimerProcessFingerprint: "test:manifest-only",
              expectedDevice: 1,
              expectedInode: 1,
              createdAt,
            })}\n`
      )

      const fileSystem = new SecureFileSystem({
        root: fixture.root,
        now: () => now,
        lockStaleAfterMs: 60_000,
        processSignal() {
          throw Object.assign(new Error("dead"), { code: "ESRCH" })
        },
      })
      await expect(
        fileSystem.withLock(lock, () => Promise.resolve("acquired"))
      ).resolves.toBe("acquired")
      expect(await fileSystem.exists(lock)).toBe(false)
      expect(await fileSystem.exists(manifest)).toBe(true)
      expect(
        (await readdir(fixture.root)).filter((name) =>
          name.endsWith(".reclaim-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.lock")
        )
      ).toHaveLength(0)
    }
  )

  it("fails closed when a hard-link claim has a damaged manifest", async () => {
    fixture = await createTemporaryStateFixture({ lockStaleAfterMs: 0 })
    await fixture.fileSystem.ensureRoot()
    const lock = fixture.paths.authLock
    const claimToken = "88888888-8888-4888-8888-888888888888"
    await fixture.fileSystem.atomicWrite(
      lock,
      `${JSON.stringify({
        formatVersion: 1,
        pid: 2_000_000_000,
        ownerToken: "99999999-9999-4999-8999-999999999999",
        createdAt: "2026-07-31T08:00:00.000Z",
      })}\n`
    )
    await link(lock, `${lock}.reclaim-${claimToken}.lock`)
    await fixture.fileSystem.atomicWrite(
      `${lock}.reclaim-${claimToken}.json`,
      "{}\n"
    )

    await expect(
      fixture.fileSystem.withLock(lock, () => Promise.resolve("unexpected"))
    ).rejects.toBeInstanceOf(SecureFileLockBusyError)
    expect(await fixture.fileSystem.exists(lock)).toBe(true)
  })
})
