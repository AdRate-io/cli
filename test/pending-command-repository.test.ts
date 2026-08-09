import {
  chmod,
  link,
  lstat,
  open,
  readdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  createPreparedPendingCommand,
  parsePendingCommandRecord,
  pendingIntentHash,
  pendingRecordId,
  serializePendingCommand,
} from "../src/commands/pending-command-contract.js"
import {
  PendingCommandChangedError,
  PendingCommandRepository,
} from "../src/commands/pending-command-repository.js"
import {
  SecureFileError,
  SecureFileSystem,
} from "../src/storage/secure-files.js"
import { CREDENTIAL_ID, createTemporaryStateFixture, statusIntent } from "./helpers.js"
import type { NewPendingCommandRecord } from "../src/commands/pending-command-contract.js"
import type { TemporaryStateFixture } from "./helpers.js"

const OTHER_CREDENTIAL_ID = "77777777-7777-4777-8777-777777777777"
const NOW = new Date("2026-07-31T08:00:00.000Z")

function input(
  overrides: Partial<NewPendingCommandRecord> = {}
): NewPendingCommandRecord {
  return {
    idempotencyKey: "abc_DEF-9",
    credentialId: CREDENTIAL_ID,
    issuerOrigin: "https://api.adrate.io",
    teamId: 42,
    capabilityId: "ads.campaign.status.write",
    intent: statusIntent(),
    now: NOW,
    ...overrides,
  }
}

let fixture: TemporaryStateFixture
let repository: PendingCommandRepository

beforeEach(async () => {
  fixture = await createTemporaryStateFixture()
  repository = new PendingCommandRepository(fixture.fileSystem, fixture.paths)
})

afterEach(async () => {
  await fixture.cleanup()
})

describe("pending Command frozen contract", () => {
  it("creates a strict canonical prepared record", () => {
    const record = createPreparedPendingCommand(input())

    expect(record).toEqual({
      formatVersion: 2,
      idempotencyKey: "abc_DEF-9",
      capabilityId: "ads.campaign.status.write",
      credentialKind: "owner_cli_session",
      credentialId: CREDENTIAL_ID,
      issuerOrigin: "https://api.adrate.io",
      teamId: 42,
      intent: input().intent,
      intentHash: pendingIntentHash(input().intent),
      localState: "prepared",
      commandId: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      lastResponse: null,
    })
    expect(
      parsePendingCommandRecord(JSON.parse(serializePendingCommand(record)))
    ).toEqual(record)
  })

  it("tolerates extra fields on persisted records", () => {
    const record = createPreparedPendingCommand(input())
    expect(parsePendingCommandRecord({ ...record, extra: true })).not.toBeNull()
  })

  it.each([
    ["unknown format", { formatVersion: 3 }],
    ["unsafe issuer", { issuerOrigin: "https://evil.example" }],
    ["bad credential", { credentialId: "credential" }],
    ["intent hash drift", { intentHash: "0".repeat(64) }],
    ["updated before created", { updatedAt: "2026-07-31T07:59:59.999Z" }],
    [
      "prepared with command id",
      { commandId: "018f15d1-7d8f-7ea1-a492-8b7f8271fc6e" },
    ],
  ])("rejects %s", (_label, patch) => {
    const record = createPreparedPendingCommand(input())
    expect(parsePendingCommandRecord({ ...record, ...patch })).toBeNull()
  })

  it("rejects non-transportable persisted resource IDs", () => {
    const record = createPreparedPendingCommand(input())
    const intent = { ...record.intent, campaignId: "needs encoding" }
    expect(
      parsePendingCommandRecord({
        ...record,
        intent,
        intentHash: pendingIntentHash(intent),
      })
    ).toBeNull()
  })
})

describe("PendingCommandRepository", () => {
  it("uses SHA-256 filenames and atomically creates a 0600 record", async () => {
    const result = await repository.prepare(input())

    expect(result.kind).toBe("created")
    const recordId = pendingRecordId("abc_DEF-9")
    const path = join(fixture.paths.pendingCommands, `${recordId}.json`)
    expect((await lstat(path)).mode & 0o777).toBe(0o600)
    expect((await lstat(fixture.paths.pendingCommands)).mode & 0o777).toBe(
      0o700
    )
    expect(await readdir(fixture.paths.pendingCommands)).toEqual([
      `${recordId}.json`,
    ])
    expect(path).not.toContain("abc_DEF-9")
  })

  it("returns the existing record for the same key or same resource intent", async () => {
    expect((await repository.prepare(input())).kind).toBe("created")

    const sameKey = await repository.prepare(input())
    const newKey = await repository.prepare(
      input({ idempotencyKey: "another-key" })
    )

    expect(sameKey.kind).toBe("existing_same_intent")
    expect(newKey.kind).toBe("existing_same_intent")
    expect(await readdir(fixture.paths.pendingCommands)).toHaveLength(1)
  })

  it("separates idempotency, resource intent, credential, and issuer conflicts", async () => {
    expect((await repository.prepare(input())).kind).toBe("created")

    expect(
      (
        await repository.prepare(
          input({
            credentialId: OTHER_CREDENTIAL_ID,
          })
        )
      ).kind
    ).toBe("credential_mismatch")
    expect(
      (
        await repository.prepare(
          input({
            intent: statusIntent({ desiredStatus: "DISABLE" }),
          })
        )
      ).kind
    ).toBe("idempotency_conflict")
    expect(
      (
        await repository.prepare(
          input({
            idempotencyKey: "opposite-key",
            intent: statusIntent({ desiredStatus: "DISABLE" }),
          })
        )
      ).kind
    ).toBe("resource_intent_conflict")
    expect(
      (
        await repository.prepare(
          input({
            idempotencyKey: "new-credential-key",
            credentialId: OTHER_CREDENTIAL_ID,
          })
        )
      ).kind
    ).toBe("prior_credential")
    expect(
      (
        await repository.prepare(
          input({ issuerOrigin: "https://api.test.adrate.io" })
        )
      ).kind
    ).toBe("credential_mismatch")
  })

  it("recovers a secure pre-link atomic temp residue without poisoning scan or prepare", async () => {
    await fixture.fileSystem.ensureDirectory(fixture.paths.pendingCommands)
    const recordId = pendingRecordId(input().idempotencyKey)
    const temporary = join(
      fixture.paths.pendingCommands,
      `${recordId}.json.tmp-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
    )
    // 强制终止可留下尚未写完、从未发布的 0600 temp。
    await writeFile(temporary, '{"incomplete":', { mode: 0o600 })

    expect(await repository.scan()).toEqual({
      records: [],
      invalidEntries: [],
    })
    expect((await repository.prepare(input())).kind).toBe("created")
    expect(await fixture.fileSystem.exists(temporary)).toBe(true)
    expect(await repository.scan()).toMatchObject({
      records: [{ recordId }],
      invalidEntries: [],
    })
  })

  it("ignores a secure post-link hard-link residue while trusting only the canonical record", async () => {
    const created = await repository.prepare(input())
    if (created.kind !== "created") throw new Error("expected created")
    const canonical = repository.recordPath(input().idempotencyKey)
    const temporary = `${canonical}.tmp-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`
    await link(canonical, temporary)

    const scan = await repository.scan()

    expect(scan).toEqual({
      records: [{ recordId: created.recordId, record: created.record }],
      invalidEntries: [],
    })
    expect((await lstat(canonical)).nlink).toBe(2)
    expect((await repository.prepare(input())).kind).toBe(
      "existing_same_intent"
    )
    expect(await fixture.fileSystem.exists(temporary)).toBe(true)
  })

  it("does not let another resource's active atomic temp block a concurrent prepare", async () => {
    await fixture.fileSystem.ensureDirectory(fixture.paths.pendingCommands)
    const activeId = pendingRecordId("active-temp-key")
    const temporary = join(
      fixture.paths.pendingCommands,
      `${activeId}.json.tmp-cccccccc-cccc-4ccc-8ccc-cccccccccccc`
    )
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile("{")
      const result = await repository.prepare(
        input({
          idempotencyKey: "concurrent-resource-key",
          intent: { ...input().intent, campaignId: "90001" },
        })
      )
      expect(result.kind).toBe("created")
      expect((await repository.scan()).invalidEntries).toEqual([])
    } finally {
      await handle.close()
      await unlink(temporary)
    }
  })

  it("fails loud for forged temp symlinks, broad permissions, and near-match names", async () => {
    if (process.platform === "win32") return
    await fixture.fileSystem.ensureDirectory(fixture.paths.pendingCommands)
    const permissionId = pendingRecordId("temp-permission")
    const permissionPath = join(
      fixture.paths.pendingCommands,
      `${permissionId}.json.tmp-dddddddd-dddd-4ddd-8ddd-dddddddddddd`
    )
    await writeFile(permissionPath, "{}", { mode: 0o600 })
    await chmod(permissionPath, 0o644)
    const symlinkId = pendingRecordId("temp-symlink")
    await symlink(
      permissionPath,
      join(
        fixture.paths.pendingCommands,
        `${symlinkId}.json.tmp-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee`
      )
    )
    await writeFile(
      join(
        fixture.paths.pendingCommands,
        `${pendingRecordId("near-match")}.json.tmp-NOT-A-UUID`
      ),
      "{}",
      { mode: 0o600 }
    )

    const scan = await repository.scan()

    expect(scan.records).toEqual([])
    expect(scan.invalidEntries).toEqual(
      expect.arrayContaining([
        { recordId: permissionId, reason: "permission" },
        { recordId: symlinkId, reason: "symlink" },
        { recordId: null, reason: "schema" },
      ])
    )
    expect((await repository.prepare(input())).kind).toBe("unsafe")
  })

  it("allows only one of two concurrent resource publishers", async () => {
    const peerFileSystem = new SecureFileSystem({ root: fixture.root })
    const peer = new PendingCommandRepository(peerFileSystem, fixture.paths)

    const results = await Promise.all([
      repository.prepare(input()),
      peer.prepare(input({ idempotencyKey: "peer-key" })),
    ])

    expect(results.map((result) => result.kind).sort()).toEqual([
      "created",
      "existing_same_intent",
    ])
    expect(await readdir(fixture.paths.pendingCommands)).toHaveLength(1)
  })

  it("fails loud on malformed JSON, unsafe permissions, and symlinks", async () => {
    await fixture.fileSystem.ensureDirectory(fixture.paths.pendingCommands)
    const malformedId = pendingRecordId("malformed")
    await fixture.fileSystem.atomicWrite(
      join(fixture.paths.pendingCommands, `${malformedId}.json`),
      "{"
    )
    const permissionId = pendingRecordId("permission")
    const permissionPath = join(
      fixture.paths.pendingCommands,
      `${permissionId}.json`
    )
    await writeFile(permissionPath, "{}\n", { mode: 0o600 })
    await chmod(permissionPath, 0o644)
    const symlinkId = pendingRecordId("symlink")
    await symlink(
      permissionPath,
      join(fixture.paths.pendingCommands, `${symlinkId}.json`)
    )

    const scan = await repository.scan()

    expect(scan.records).toEqual([])
    expect(scan.invalidEntries).toEqual(
      expect.arrayContaining([
        { recordId: malformedId, reason: "invalid_json" },
        { recordId: permissionId, reason: "permission" },
        { recordId: symlinkId, reason: "symlink" },
      ])
    )
    const prepare = await repository.prepare(input())
    expect(prepare.kind).toBe("unsafe")
  })

  it("never reflects an untrusted basename that resembles a Key or Token", async () => {
    await fixture.fileSystem.ensureDirectory(fixture.paths.pendingCommands)
    const keyLikeName = "abc_DEF-9"
    const tokenLikeName =
      "adr_owner_11111111-1111-4111-8111-111111111111_FAKESECRET"
    await fixture.fileSystem.atomicWrite(
      join(fixture.paths.pendingCommands, keyLikeName),
      "{}\n"
    )
    await fixture.fileSystem.atomicWrite(
      join(fixture.paths.pendingCommands, tokenLikeName),
      "{}\n"
    )

    const scan = await repository.scan()
    const rendered = JSON.stringify(scan.invalidEntries)

    expect(scan.records).toEqual([])
    expect(scan.invalidEntries).toEqual([
      { recordId: null, reason: "schema" },
      { recordId: null, reason: "schema" },
    ])
    expect(rendered).not.toContain(keyLikeName)
    expect(rendered).not.toContain(tokenLikeName)
    expect(rendered).not.toContain(fixture.paths.pendingCommands)
  })

  it("detects filename/hash mismatch without deleting evidence", async () => {
    await fixture.fileSystem.ensureDirectory(fixture.paths.pendingCommands)
    const record = createPreparedPendingCommand(input())
    const wrongId = "0".repeat(64)
    const path = join(fixture.paths.pendingCommands, `${wrongId}.json`)
    await fixture.fileSystem.atomicWrite(path, serializePendingCommand(record))

    const scan = await repository.scan()

    expect(scan.records).toEqual([])
    expect(scan.invalidEntries).toEqual([
      { recordId: wrongId, reason: "hash_mismatch" },
    ])
    expect(await fixture.fileSystem.exists(path)).toBe(true)
  })

  it("detects duplicate idempotency keys before trusting either file", async () => {
    await fixture.fileSystem.ensureDirectory(fixture.paths.pendingCommands)
    const record = createPreparedPendingCommand(input())
    const canonicalId = pendingRecordId(record.idempotencyKey)
    const duplicateId = "f".repeat(64)
    await fixture.fileSystem.atomicWrite(
      join(fixture.paths.pendingCommands, `${canonicalId}.json`),
      serializePendingCommand(record)
    )
    await fixture.fileSystem.atomicWrite(
      join(fixture.paths.pendingCommands, `${duplicateId}.json`),
      serializePendingCommand(record)
    )

    const scan = await repository.scan()

    expect(scan.records).toEqual([])
    expect(scan.invalidEntries).toEqual([
      { recordId: canonicalId, reason: "duplicate_key" },
      { recordId: duplicateId, reason: "duplicate_key" },
    ])
  })

  it("uses exact-record CAS for replace and delete", async () => {
    const created = await repository.prepare(input())
    expect(created.kind).toBe("created")
    if (created.kind !== "created") throw new Error("expected created")
    const next = parsePendingCommandRecord({
      ...created.record,
      localState: "response_unknown",
      updatedAt: "2026-07-31T08:00:01.000Z",
      lastResponse: {
        requestId: null,
        httpStatus: null,
        errorCode: null,
      },
    })
    if (!next) throw new Error("expected valid next record")

    await repository.replaceExact(created.record, next)
    await expect(
      repository.replaceExact(created.record, next)
    ).rejects.toBeInstanceOf(PendingCommandChangedError)
    await expect(repository.removeExact(created.record)).rejects.toBeInstanceOf(
      PendingCommandChangedError
    )
    await expect(repository.removeExact(next)).resolves.toBe(true)
    await expect(repository.removeExact(next)).resolves.toBe(false)
  })

  it("serializes concurrent updates with the hashed Key lock", async () => {
    const created = await repository.prepare(input())
    if (created.kind !== "created") throw new Error("expected created")
    const responseUnknown = parsePendingCommandRecord({
      ...created.record,
      localState: "response_unknown",
      updatedAt: "2026-07-31T08:00:01.000Z",
    })
    const expired = parsePendingCommandRecord({
      ...created.record,
      localState: "expired_unsubmitted",
      updatedAt: "2026-07-31T08:00:02.000Z",
    })
    if (!responseUnknown || !expired) throw new Error("expected valid updates")
    const peer = new PendingCommandRepository(
      new SecureFileSystem({ root: fixture.root }),
      fixture.paths
    )

    const results = await Promise.allSettled([
      repository.replaceExact(created.record, responseUnknown),
      peer.replaceExact(created.record, expired),
    ])

    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1)
    const rejected = results.find((result) => result.status === "rejected")
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.any(PendingCommandChangedError),
    })
    const current = await repository.read(created.record.idempotencyKey)
    expect(current.kind).toBe("found")
    if (current.kind === "found") {
      expect(["response_unknown", "expired_unsubmitted"]).toContain(
        current.record.localState
      )
    }
  })

  it("derives isolated deterministic resource and key locks", () => {
    const production = repository.resourceLockPath(input())
    const same = repository.resourceLockPath(input())
    const test = repository.resourceLockPath(
      input({ issuerOrigin: "https://api.test.adrate.io" })
    )

    expect(production).toBe(same)
    expect(production).not.toBe(test)
    expect(repository.keyLockPath("abc_DEF-9")).not.toContain("abc_DEF-9")
    expect(() => repository.recordPath("../escape")).toThrow(SecureFileError)
  })
})
