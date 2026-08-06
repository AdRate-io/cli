import { Buffer } from "node:buffer"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  CREDENTIAL_READINESS_ORIGIN_PREFIX,
  CredentialStore,
  FallbackFileCredentialBackend,
  KeytarCredentialBackend,
  credentialStorageWarning,
  isCredentialReadinessAddress,
} from "../src/storage/credential-backend.js"
import {
  CREDENTIAL_ID,
  OWNER_SESSION_TOKEN,
  createTemporaryStateFixture,
  validTokenIndex,
} from "./helpers.js"
import type {
  CredentialAddress,
  CredentialBackend,
  KeytarApi,
} from "../src/storage/credential-backend.js"
import type { TokenIndex, TokenStorageKind } from "../src/storage/schemas.js"
import type { TemporaryStateFixture } from "./helpers.js"

class MemoryKeytar implements KeytarApi {
  readonly values = new Map<string, string>()
  readonly reads: Array<{ service: string; account: string }> = []
  readonly writes: Array<{
    service: string
    account: string
    password: string
  }> = []
  readonly removals: Array<{ service: string; account: string }> = []

  getPassword(service: string, account: string): Promise<string | null> {
    this.reads.push({ service, account })
    return Promise.resolve(this.values.get(`${service}\0${account}`) ?? null)
  }

  setPassword(
    service: string,
    account: string,
    password: string
  ): Promise<void> {
    this.writes.push({ service, account, password })
    this.values.set(`${service}\0${account}`, password)
    return Promise.resolve()
  }

  deletePassword(service: string, account: string): Promise<boolean> {
    this.removals.push({ service, account })
    return Promise.resolve(this.values.delete(`${service}\0${account}`))
  }
}

class FakeBackend implements CredentialBackend {
  private readonly values = new Map<string, string>()
  readonly isAvailable = vi.fn<CredentialBackend["isAvailable"]>(() =>
    Promise.resolve(true)
  )
  readonly read = vi.fn<CredentialBackend["read"]>((address) =>
    Promise.resolve(this.values.get(this.key(address)) ?? null)
  )
  readonly write = vi.fn<CredentialBackend["write"]>((address, token) => {
    this.values.set(this.key(address), token)
    return Promise.resolve()
  })
  readonly remove = vi.fn<CredentialBackend["remove"]>((address) => {
    this.values.delete(this.key(address))
    return Promise.resolve()
  })

  constructor(readonly kind: TokenStorageKind) {}

  private key(address: CredentialAddress): string {
    return `${address.issuerOrigin}\0${address.credentialId}`
  }
}

let fixture: TemporaryStateFixture | null = null
const itPosix = process.platform === "win32" ? it.skip : it

afterEach(async () => {
  vi.restoreAllMocks()
  if (fixture) await fixture.cleanup()
  fixture = null
})

describe("KeytarCredentialBackend", () => {
  it("uses the exact issuer + kind + credential address and never a global scan", async () => {
    const api = new MemoryKeytar()
    const backend = new KeytarCredentialBackend(() => Promise.resolve(api))
    const address: CredentialAddress = {
      issuerOrigin: "https://api.adrate.io",
      credentialKind: "owner_cli_session",
      credentialId: CREDENTIAL_ID,
    }
    const issuerAddress = Buffer.from(address.issuerOrigin, "utf8").toString(
      "base64url"
    )
    const expectedService = `io.adrate.cli:${issuerAddress}:owner_cli_session`

    await backend.write(address, OWNER_SESSION_TOKEN)
    await expect(backend.read(address)).resolves.toBe(OWNER_SESSION_TOKEN)
    await backend.remove(address)

    expect(api.writes).toEqual([
      {
        service: expectedService,
        account: CREDENTIAL_ID,
        password: OWNER_SESSION_TOKEN,
      },
    ])
    expect(api.reads).toEqual([
      { service: expectedService, account: CREDENTIAL_ID },
      { service: expectedService, account: CREDENTIAL_ID },
      { service: expectedService, account: CREDENTIAL_ID },
    ])
    expect(api.removals).toEqual([
      { service: expectedService, account: CREDENTIAL_ID },
    ])
  })

  it("isolates the same credential id between production and test issuers", async () => {
    const api = new MemoryKeytar()
    const backend = new KeytarCredentialBackend(() => Promise.resolve(api))
    const production: CredentialAddress = {
      issuerOrigin: "https://api.adrate.io",
      credentialKind: "owner_cli_session",
      credentialId: CREDENTIAL_ID,
    }
    const test: CredentialAddress = {
      ...production,
      issuerOrigin: "https://api.test.adrate.io",
    }
    const testToken = OWNER_SESSION_TOKEN.replace(/A$/u, "B")

    await backend.write(production, OWNER_SESSION_TOKEN)
    await backend.write(test, testToken)

    await expect(backend.read(production)).resolves.toBe(OWNER_SESSION_TOKEN)
    await expect(backend.read(test)).resolves.toBe(testToken)
    expect(new Set(api.writes.map((entry) => entry.service)).size).toBe(2)
  })

  it("does not overwrite a different secret at the exact address", async () => {
    const api = new MemoryKeytar()
    const backend = new KeytarCredentialBackend(() => Promise.resolve(api))
    const address: CredentialAddress = {
      issuerOrigin: "https://api.adrate.io",
      credentialKind: "owner_cli_session",
      credentialId: CREDENTIAL_ID,
    }
    await backend.write(address, OWNER_SESSION_TOKEN)

    await expect(
      backend.write(address, OWNER_SESSION_TOKEN.replace(/A$/u, "B"))
    ).rejects.toMatchObject({ name: "CliFailure", exitCode: 2 })
    expect(api.writes).toHaveLength(1)
  })

  it("confirms idempotent removal by exact-address post-read when macOS keytar rejects not-found", async () => {
    const address: CredentialAddress = {
      issuerOrigin: "https://api.adrate.io",
      credentialKind: "owner_cli_session",
      credentialId: CREDENTIAL_ID,
    }
    let stored: string | null = OWNER_SESSION_TOKEN
    let deleteCalls = 0
    const api: KeytarApi = {
      getPassword: () => Promise.resolve(stored),
      setPassword: (_service, _account, password) => {
        stored = password
        return Promise.resolve()
      },
      deletePassword: () => {
        deleteCalls += 1
        if (stored === null) {
          return Promise.reject(new Error("native not-found rejection"))
        }
        stored = null
        return Promise.resolve(true)
      },
    }
    const backend = new KeytarCredentialBackend(() => Promise.resolve(api))

    await expect(backend.remove(address)).resolves.toBeUndefined()
    await expect(backend.remove(address)).resolves.toBeUndefined()
    expect(deleteCalls).toBe(2)
    expect(stored).toBeNull()
  })

  it("fails removal when neither delete nor post-read can prove absence", async () => {
    const address: CredentialAddress = {
      issuerOrigin: "https://api.adrate.io",
      credentialKind: "owner_cli_session",
      credentialId: CREDENTIAL_ID,
    }
    const api: KeytarApi = {
      getPassword: () => Promise.resolve(OWNER_SESSION_TOKEN),
      setPassword: () => Promise.resolve(),
      deletePassword: () =>
        Promise.reject(new Error("backend deletion unavailable")),
    }
    const backend = new KeytarCredentialBackend(() => Promise.resolve(api))

    await expect(backend.remove(address)).rejects.toMatchObject({
      name: "CliFailure",
      exitCode: 4,
    })
  })
})

describe("CredentialStore backend pinning", () => {
  it("proves Keychain readiness with random set/read/compare/delete and a second cleanup", async () => {
    const api = new MemoryKeytar()
    const store = new CredentialStore(
      new KeytarCredentialBackend(() => Promise.resolve(api)),
      new FakeBackend("fallback_file")
    )

    await expect(store.selectForNewCredential()).resolves.toMatchObject({
      backend: { kind: "keychain" },
    })
    await expect(store.selectForNewCredential()).resolves.toMatchObject({
      backend: { kind: "keychain" },
    })

    expect(api.writes).toHaveLength(2)
    expect(api.removals).toHaveLength(4)
    expect(api.values.size).toBe(0)
    expect(api.writes[0]!.service).not.toBe(api.writes[1]!.service)
    expect(api.writes[0]!.account).not.toBe(api.writes[1]!.account)
    expect(api.writes[0]!.password).not.toBe(api.writes[1]!.password)
    for (const write of api.writes) {
      expect(write.service).toMatch(/^io\.adrate\.cli:/u)
      expect(write.account).toMatch(/^[0-9a-f-]{36}$/u)
      expect(write.password).toMatch(
        new RegExp(`^adr_owner_${write.account}_[A-Za-z0-9_-]{43}$`, "u")
      )
      expect(
        api.reads.some(
          (read) =>
            read.service === write.service && read.account === write.account
        )
      ).toBe(true)
      expect(
        api.removals.filter(
          (removal) =>
            removal.service === write.service &&
            removal.account === write.account
        )
      ).toHaveLength(2)
    }
  })

  it.each([
    ["read", "read"],
    ["write", "write"],
  ] as const)(
    "falls back safely when Keychain readiness %s fails and cleanup is confirmed",
    async (_label, method) => {
      const keychain = new FakeBackend("keychain")
      const fallback = new FakeBackend("fallback_file")
      keychain[method].mockRejectedValue(new Error(`${method} unavailable`))
      const store = new CredentialStore(keychain, fallback)

      await expect(store.selectForNewCredential()).resolves.toMatchObject({
        backend: fallback,
      })
      expect(fallback.write).toHaveBeenCalledOnce()
      expect(fallback.remove).toHaveBeenCalledTimes(2)
    }
  )

  it("rejects a same-length readiness reread mismatch and falls back only after cleanup", async () => {
    const keychain = new FakeBackend("keychain")
    const fallback = new FakeBackend("fallback_file")
    keychain.read
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("X".repeat(90))
    const store = new CredentialStore(keychain, fallback)

    await expect(store.selectForNewCredential()).resolves.toMatchObject({
      backend: fallback,
    })

    expect(keychain.remove).toHaveBeenCalledTimes(2)
    expect(fallback.write).toHaveBeenCalledOnce()
  })

  it("fails closed instead of falling back when Keychain readiness cleanup is uncertain", async () => {
    const keychain = new FakeBackend("keychain")
    const fallback = new FakeBackend("fallback_file")
    keychain.remove.mockRejectedValue(new Error("delete unavailable"))
    const store = new CredentialStore(keychain, fallback)

    await expect(store.selectForNewCredential()).rejects.toMatchObject({
      name: "CliFailure",
      exitCode: 4,
    })
    expect(keychain.remove).toHaveBeenCalledTimes(2)
    expect(fallback.isAvailable).not.toHaveBeenCalled()
    expect(fallback.write).not.toHaveBeenCalled()
  })

  it("fails before selection when fallback readiness cannot write", async () => {
    const keychain = new FakeBackend("keychain")
    const fallback = new FakeBackend("fallback_file")
    keychain.isAvailable.mockResolvedValue(false)
    fallback.write.mockRejectedValue(new Error("write unavailable"))
    const store = new CredentialStore(keychain, fallback)

    await expect(store.selectForNewCredential()).rejects.toMatchObject({
      name: "CliFailure",
      exitCode: 4,
    })
    expect(fallback.remove).toHaveBeenCalledTimes(2)
  })

  it("derives the fallback warning only from the persisted storage kind", async () => {
    const keychain = new FakeBackend("keychain")
    keychain.isAvailable.mockResolvedValue(false)
    const fallback = new FakeBackend("fallback_file")
    const store = new CredentialStore(keychain, fallback)

    const selection = await store.selectForNewCredential()

    expect(selection.backend).toBe(fallback)
    expect(credentialStorageWarning(selection.backend.kind)).toContain(
      "Keychain is unavailable"
    )
    expect(credentialStorageWarning("keychain")).toBeNull()
    expect(keychain.isAvailable).toHaveBeenCalledOnce()
    expect(fallback.isAvailable).toHaveBeenCalledOnce()
  })

  it("fails closed when neither fresh backend can prove availability", async () => {
    const keychain = new FakeBackend("keychain")
    const fallback = new FakeBackend("fallback_file")
    keychain.isAvailable.mockResolvedValue(false)
    fallback.isAvailable.mockResolvedValue(false)
    const store = new CredentialStore(keychain, fallback)

    await expect(store.selectForNewCredential()).rejects.toMatchObject({
      name: "CliFailure",
      exitCode: 4,
    })
  })

  it("hard-fails a stored keychain index when the optional module cannot load and never falls back", async () => {
    const keychain = new KeytarCredentialBackend(() =>
      Promise.reject(new Error("module missing"))
    )
    const fallback = new FakeBackend("fallback_file")
    const store = new CredentialStore(keychain, fallback)

    await expect(store.read(validTokenIndex())).rejects.toMatchObject({
      name: "CliFailure",
      exitCode: 4,
    })
    expect(fallback.isAvailable).not.toHaveBeenCalled()
    expect(fallback.read).not.toHaveBeenCalled()
  })

  it("hard-fails a stored keychain index on backend read errors and never falls back", async () => {
    const api: KeytarApi = {
      getPassword() {
        return Promise.reject(new Error("backend locked"))
      },
      setPassword() {
        return Promise.reject(new Error("unexpected"))
      },
      deletePassword() {
        return Promise.reject(new Error("unexpected"))
      },
    }
    const keychain = new KeytarCredentialBackend(() => Promise.resolve(api))
    const fallback = new FakeBackend("fallback_file")
    const store = new CredentialStore(keychain, fallback)

    await expect(store.read(validTokenIndex())).rejects.toMatchObject({
      name: "CliFailure",
      exitCode: 4,
    })
    expect(fallback.read).not.toHaveBeenCalled()
  })

  it("uses the backend pinned by token-index without probing the other backend", async () => {
    const keychain = new FakeBackend("keychain")
    const fallback = new FakeBackend("fallback_file")
    fallback.read.mockResolvedValue(OWNER_SESSION_TOKEN)
    const store = new CredentialStore(keychain, fallback)
    const index: TokenIndex = validTokenIndex({
      storageKind: "fallback_file",
    })

    await expect(store.read(index)).resolves.toBe(OWNER_SESSION_TOKEN)
    expect(fallback.read).toHaveBeenCalledWith(store.addressFor(index))
    expect(keychain.isAvailable).not.toHaveBeenCalled()
    expect(keychain.read).not.toHaveBeenCalled()
  })
})

describe("FallbackFileCredentialBackend", () => {
  itPosix(
    "proves real fallback readiness and removes the dummy in both cleanup passes",
    async () => {
      fixture = await createTemporaryStateFixture()
      const keychain = new FakeBackend("keychain")
      keychain.isAvailable.mockResolvedValue(false)
      const fallback = new FallbackFileCredentialBackend(
        fixture.fileSystem,
        fixture.paths,
        "linux"
      )
      const atomicWrite = vi.spyOn(fixture.fileSystem, "atomicWrite")
      const rawRemove = vi.spyOn(fixture.fileSystem, "removeSecureFile")
      const store = new CredentialStore(keychain, fallback)

      await expect(store.selectForNewCredential()).resolves.toMatchObject({
        backend: fallback,
      })

      expect(atomicWrite).toHaveBeenCalledOnce()
      expect(rawRemove).toHaveBeenCalledTimes(2)
      expect(await fixture.fileSystem.exists(fixture.paths.fallbackToken)).toBe(
        false
      )
    }
  )

  itPosix("stores only the strict one-line owner token format", async () => {
    fixture = await createTemporaryStateFixture()
    const backend = new FallbackFileCredentialBackend(
      fixture.fileSystem,
      fixture.paths,
      "linux"
    )
    const address: CredentialAddress = {
      issuerOrigin: "https://api.adrate.io",
      credentialKind: "owner_cli_session",
      credentialId: CREDENTIAL_ID,
    }

    await backend.write(address, OWNER_SESSION_TOKEN)
    await expect(backend.read(address)).resolves.toBe(OWNER_SESSION_TOKEN)
    expect(
      await fixture.fileSystem.readSecureFile(fixture.paths.fallbackToken)
    ).toBe(`${OWNER_SESSION_TOKEN}\n`)

    await fixture.fileSystem.atomicWrite(
      fixture.paths.fallbackToken,
      OWNER_SESSION_TOKEN
    )
    await expect(backend.read(address)).resolves.toBe(OWNER_SESSION_TOKEN)
  })

  itPosix.each([
    ["JSON wrapping", `{"token":"${OWNER_SESSION_TOKEN}"}`],
    ["extra line", `${OWNER_SESSION_TOKEN}\nextra\n`],
    ["blank extra line", `${OWNER_SESSION_TOKEN}\n\n`],
    ["carriage return", `${OWNER_SESSION_TOKEN}\r\n`],
    ["NUL", `${OWNER_SESSION_TOKEN}\0`],
    ["wrong credential shape", "not-a-session-token\n"],
  ])("rejects %s in the fallback file", async (_label, content) => {
    fixture = await createTemporaryStateFixture()
    const backend = new FallbackFileCredentialBackend(
      fixture.fileSystem,
      fixture.paths,
      "linux"
    )
    const address: CredentialAddress = {
      issuerOrigin: "https://api.adrate.io",
      credentialKind: "owner_cli_session",
      credentialId: CREDENTIAL_ID,
    }
    await fixture.fileSystem.atomicWrite(fixture.paths.fallbackToken, content)

    await expect(backend.read(address)).rejects.toMatchObject({
      name: "CliFailure",
      exitCode: 2,
    })
  })

  it("fails closed on Windows instead of treating POSIX mode bits as ACL proof", async () => {
    fixture = await createTemporaryStateFixture()
    const backend = new FallbackFileCredentialBackend(
      fixture.fileSystem,
      fixture.paths,
      "win32"
    )
    const address: CredentialAddress = {
      issuerOrigin: "https://api.adrate.io",
      credentialKind: "owner_cli_session",
      credentialId: CREDENTIAL_ID,
    }

    await expect(backend.isAvailable()).resolves.toBe(false)
    await expect(
      backend.write(address, OWNER_SESSION_TOKEN)
    ).rejects.toMatchObject({
      name: "CliFailure",
      exitCode: 4,
    })
    expect(await fixture.fileSystem.exists(fixture.paths.fallbackToken)).toBe(
      false
    )
  })

  it("never reads or removes a legacy fallback token on Windows", async () => {
    fixture = await createTemporaryStateFixture()
    await fixture.fileSystem.atomicWrite(
      fixture.paths.fallbackToken,
      `${OWNER_SESSION_TOKEN}\n`
    )
    const readFile = vi.spyOn(fixture.fileSystem, "readSecureFile")
    const removeFile = vi.spyOn(fixture.fileSystem, "removeSecureFile")
    const backend = new FallbackFileCredentialBackend(
      fixture.fileSystem,
      fixture.paths,
      "win32"
    )
    const keychain = new FakeBackend("keychain")
    const store = new CredentialStore(keychain, backend)
    const legacyIndex = validTokenIndex({ storageKind: "fallback_file" })

    await expect(store.read(legacyIndex)).rejects.toMatchObject({
      name: "CliFailure",
      exitCode: 4,
    })
    await expect(store.remove(legacyIndex)).rejects.toMatchObject({
      name: "CliFailure",
      exitCode: 4,
    })

    expect(keychain.read).not.toHaveBeenCalled()
    expect(keychain.remove).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
    expect(removeFile).not.toHaveBeenCalled()
    expect(await fixture.fileSystem.exists(fixture.paths.fallbackToken)).toBe(
      true
    )
  })

  it.each([
    ["legacy fallback index", "fallback_file"],
    ["keychain index plus orphan fallback", "keychain"],
  ] as const)(
    "keeps Windows %s fail-closed through authentication cleanup",
    async (_label, storageKind) => {
      fixture = await createTemporaryStateFixture()
      await fixture.fileSystem.atomicWrite(
        fixture.paths.fallbackToken,
        `${OWNER_SESSION_TOKEN}\n`
      )
      const rawRemove = vi.spyOn(fixture.fileSystem, "removeSecureFile")
      const fallback = new FallbackFileCredentialBackend(
        fixture.fileSystem,
        fixture.paths,
        "win32"
      )
      const keychain = new FakeBackend("keychain")
      const store = new CredentialStore(keychain, fallback)
      const index = validTokenIndex({ storageKind })

      await expect(
        store.removeAuthenticationArtifacts(index, true)
      ).rejects.toMatchObject({ name: "CliFailure", exitCode: 4 })

      expect(rawRemove).not.toHaveBeenCalled()
      expect(keychain.remove).not.toHaveBeenCalled()
      expect(await fixture.fileSystem.exists(fixture.paths.fallbackToken)).toBe(
        true
      )
    }
  )

  itPosix(
    "still removes an orphan POSIX fallback through its backend",
    async () => {
      fixture = await createTemporaryStateFixture()
      await fixture.fileSystem.atomicWrite(
        fixture.paths.fallbackToken,
        `${OWNER_SESSION_TOKEN}\n`
      )
      const rawRemove = vi.spyOn(fixture.fileSystem, "removeSecureFile")
      const fallback = new FallbackFileCredentialBackend(
        fixture.fileSystem,
        fixture.paths,
        "linux"
      )
      const store = new CredentialStore(new FakeBackend("keychain"), fallback)

      // canonical fallback Token 的删除必须在 auth lock 内完成，
      // 生产的登出清理也保持同一条边界。
      await fixture.fileSystem.withLock(fixture.paths.authLock, () =>
        store.removeAuthenticationArtifacts(null, true)
      )

      expect(rawRemove).toHaveBeenCalledOnce()
      expect(await fixture.fileSystem.exists(fixture.paths.fallbackToken)).toBe(
        false
      )
    }
  )
})

describe("fallback readiness address isolation", () => {
  itPosix(
    "never touches the canonical token address while probing",
    async () => {
      fixture = await createTemporaryStateFixture()
      const keychain = new FakeBackend("keychain")
      keychain.isAvailable.mockResolvedValue(false)
      const fallback = new FallbackFileCredentialBackend(
        fixture.fileSystem,
        fixture.paths,
        "linux"
      )
      // spyOn 默认仍然透传到真实实现，这里只用来记录实际落到磁盘的路径。
      const writeFile = vi.spyOn(fixture.fileSystem, "atomicWrite")
      const removeFile = vi.spyOn(fixture.fileSystem, "removeSecureFile")
      const readFile = vi.spyOn(fixture.fileSystem, "readSecureFile")
      const store = new CredentialStore(keychain, fallback)

      await expect(store.selectForNewCredential()).resolves.toMatchObject({
        backend: fallback,
      })

      const touched = [
        ...writeFile.mock.calls.map((call) => call[0]),
        ...removeFile.mock.calls.map((call) => call[0]),
      ]
      expect(touched).not.toHaveLength(0)
      const readinessPrefix = `${fixture.paths.fallbackToken}.readiness-`
      for (const path of touched) {
        expect(path).not.toBe(fixture.paths.fallbackToken)
        expect(path.startsWith(readinessPrefix)).toBe(true)
        expect(path.slice(readinessPrefix.length)).toMatch(/^[0-9a-f-]{36}$/u)
      }
      for (const call of readFile.mock.calls) {
        expect(call[0]).not.toBe(fixture.paths.fallbackToken)
      }
      expect(await fixture.fileSystem.exists(fixture.paths.fallbackToken)).toBe(
        false
      )
    }
  )

  itPosix(
    "leaves an existing real token byte-identical across a successful probe",
    async () => {
      fixture = await createTemporaryStateFixture()
      await fixture.fileSystem.atomicWrite(
        fixture.paths.fallbackToken,
        `${OWNER_SESSION_TOKEN}\n`
      )
      const keychain = new FakeBackend("keychain")
      keychain.isAvailable.mockResolvedValue(false)
      const fallback = new FallbackFileCredentialBackend(
        fixture.fileSystem,
        fixture.paths,
        "linux"
      )
      const store = new CredentialStore(keychain, fallback)

      // 旧实现在这里会因 "A different fallback credential already exists"
      // 直接判定 fallback 不可用；地址隔离后探测与真实凭据互不相干。
      await expect(store.selectForNewCredential()).resolves.toMatchObject({
        backend: fallback,
      })

      expect(
        await fixture.fileSystem.readSecureFile(fixture.paths.fallbackToken)
      ).toBe(`${OWNER_SESSION_TOKEN}\n`)
    }
  )

  itPosix(
    "does not delete a real token written by a peer between the probe read and write",
    async () => {
      fixture = await createTemporaryStateFixture()
      const keychain = new FakeBackend("keychain")
      keychain.isAvailable.mockResolvedValue(false)
      const fallback = new FallbackFileCredentialBackend(
        fixture.fileSystem,
        fixture.paths,
        "linux"
      )
      const store = new CredentialStore(keychain, fallback)
      const realWrite = fixture.fileSystem.atomicWrite.bind(fixture.fileSystem)
      let injected = false
      vi.spyOn(fixture.fileSystem, "atomicWrite").mockImplementation(
        async (path: string, content: string) => {
          if (!injected) {
            injected = true
            // 模拟租约被合法接管：另一个进程在本进程探测 read 之后、
            // write 之前，把真实 Token 落到 canonical 固定路径上。
            await realWrite(
              fixture!.paths.fallbackToken,
              `${OWNER_SESSION_TOKEN}\n`
            )
          }
          return realWrite(path, content)
        }
      )

      await expect(store.selectForNewCredential()).resolves.toMatchObject({
        backend: fallback,
      })

      expect(
        await fixture.fileSystem.readSecureFile(fixture.paths.fallbackToken)
      ).toBe(`${OWNER_SESSION_TOKEN}\n`)
    }
  )

  itPosix(
    "refuses to remove the canonical token without the auth lock",
    async () => {
      fixture = await createTemporaryStateFixture()
      await fixture.fileSystem.atomicWrite(
        fixture.paths.fallbackToken,
        `${OWNER_SESSION_TOKEN}\n`
      )
      const fallback = new FallbackFileCredentialBackend(
        fixture.fileSystem,
        fixture.paths,
        "linux"
      )
      const address: CredentialAddress = {
        issuerOrigin: "https://api.adrate.io",
        credentialKind: "owner_cli_session",
        credentialId: CREDENTIAL_ID,
      }

      await expect(fallback.remove(address)).rejects.toMatchObject({
        name: "SecureFileLockBusyError",
      })
      expect(
        await fixture.fileSystem.readSecureFile(fixture.paths.fallbackToken)
      ).toBe(`${OWNER_SESSION_TOKEN}\n`)

      await fixture.fileSystem.withLock(fixture.paths.authLock, () =>
        fallback.remove(address)
      )
      expect(await fixture.fileSystem.exists(fixture.paths.fallbackToken)).toBe(
        false
      )
    }
  )

  itPosix(
    "still fails closed when the canonical token is absent and no lock is held",
    async () => {
      fixture = await createTemporaryStateFixture()
      const fallback = new FallbackFileCredentialBackend(
        fixture.fileSystem,
        fixture.paths,
        "linux"
      )

      await expect(
        fallback.remove({
          issuerOrigin: "https://api.adrate.io",
          credentialKind: "owner_cli_session",
          credentialId: CREDENTIAL_ID,
        })
      ).rejects.toMatchObject({ name: "SecureFileLockBusyError" })
    }
  )

  itPosix("rejects a readiness address with an unsafe identifier", async () => {
    fixture = await createTemporaryStateFixture()
    const fallback = new FallbackFileCredentialBackend(
      fixture.fileSystem,
      fixture.paths,
      "linux"
    )

    await expect(
      fallback.read({
        issuerOrigin: `${CREDENTIAL_READINESS_ORIGIN_PREFIX}${CREDENTIAL_ID}.invalid`,
        credentialKind: "owner_cli_session",
        credentialId: "../token",
      })
    ).rejects.toMatchObject({ name: "CliFailure", exitCode: 2 })
  })

  it("classifies readiness and canonical issuers", () => {
    expect(
      isCredentialReadinessAddress({
        issuerOrigin: `${CREDENTIAL_READINESS_ORIGIN_PREFIX}${CREDENTIAL_ID}.invalid`,
        credentialKind: "owner_cli_session",
        credentialId: CREDENTIAL_ID,
      })
    ).toBe(true)
    for (const issuerOrigin of [
      "https://api.adrate.io",
      "https://api.test.adrate.io",
      `${CREDENTIAL_READINESS_ORIGIN_PREFIX}${CREDENTIAL_ID}.invalid.adrate.io`,
      `${CREDENTIAL_READINESS_ORIGIN_PREFIX}not-a-uuid.invalid`,
    ]) {
      expect(
        isCredentialReadinessAddress({
          issuerOrigin,
          credentialKind: "owner_cli_session",
          credentialId: CREDENTIAL_ID,
        })
      ).toBe(false)
    }
  })
})
