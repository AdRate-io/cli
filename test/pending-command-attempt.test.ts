import { stat, symlink } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  PendingCommandAttemptBusyError,
  PendingCommandClockRollbackError,
  parsePendingCommandAttempt,
} from "../src/commands/pending-command-attempt.js"
import { PendingCommandRepository } from "../src/commands/pending-command-repository.js"
import { settlePendingCommand } from "../src/commands/pending-command-settlement.js"
import { CommandResumeService } from "../src/commands/command-resume-service.js"
import { CommandQueryService } from "../src/commands/command-query-service.js"
import { StatusCommandDispatcher } from "../src/commands/status-command-dispatcher.js"
import { CliFailure } from "../src/errors.js"
import {
  CREDENTIAL_ID,
  OWNER_SESSION_TOKEN,
  createTemporaryStateFixture,
  validCredentialMetadata,
  validTokenIndex,
} from "./helpers.js"
import type {
  ProcessIdentity,
  ProcessIdentityProbe,
  ProcessIdentityStatus,
} from "../src/auth/process-identity.js"
import type { LocalCredentialCoordinator } from "../src/auth/local-credentials.js"
import type { PendingCommandRecord } from "../src/commands/pending-command-contract.js"
import type { PublicHttpClient, PublicResponse } from "../src/http/client.js"
import type { TemporaryStateFixture } from "./helpers.js"

const KEY = "durable-attempt-key"
const CREATED_AT = new Date("2026-08-01T00:00:00.000Z")
const OWNER_ONE = {
  pid: 43_001,
  fingerprint: "test:durable-owner:one",
} satisfies ProcessIdentity
const OWNER_TWO = {
  pid: 43_002,
  fingerprint: "test:durable-owner:two",
} satisfies ProcessIdentity
const OWNER_TOKEN_ONE = "11111111-1111-4111-8111-111111111111"
const OWNER_TOKEN_TWO = "22222222-2222-4222-8222-222222222222"
const OWNER_TOKEN_THREE = "33333333-3333-4333-8333-333333333333"

let fixture: TemporaryStateFixture
let observedAt: Date
let repository: PendingCommandRepository

function repositoryFor(input: {
  identity: ProcessIdentity
  status?: ProcessIdentityStatus
  ownerToken: string
  onCurrent?: () => Promise<void>
  onInspect?: () => Promise<void>
}): PendingCommandRepository {
  const identityProbe: ProcessIdentityProbe = {
    current: async () => {
      await input.onCurrent?.()
      return input.identity
    },
    inspect: async () => {
      await input.onInspect?.()
      return input.status ?? "same_process"
    },
  }
  return new PendingCommandRepository(fixture.fileSystem, fixture.paths, {
    now: () => new Date(observedAt),
    processIdentity: identityProbe,
    generateAttemptOwnerToken: () => input.ownerToken,
  })
}

async function seed(
  target: PendingCommandRepository = repository,
  key = KEY
): Promise<PendingCommandRecord> {
  const result = await target.prepare({
    idempotencyKey: key,
    credentialId: CREDENTIAL_ID,
    issuerOrigin: "https://api.adrate.io",
    teamId: 42,
    intent: {
      advId: "70001",
      campaignId: "80001",
      desiredStatus: "ENABLE",
      authId: null,
    },
    now: CREATED_AT,
  })
  if (result.kind !== "created") throw new Error("Expected pending record")
  return result.record
}

async function reserve(
  record: PendingCommandRecord,
  phase: "query_intent" | "post_dispatch_intent" = "query_intent"
) {
  return repository.attempts.reserve({
    expected: record,
    phase,
    observedAt: new Date(observedAt),
    allowReclaim: true,
  })
}

async function attemptText(record: PendingCommandRecord): Promise<string> {
  const text = await fixture.fileSystem.readSecureFile(
    repository.attempts.path(
      // `path` validates the already-hashed record ID obtained from read().
      (await repository.read(record.idempotencyKey)).recordId
    )
  )
  if (text === null) throw new Error("Expected attempt sidecar")
  return text
}

beforeEach(async () => {
  fixture = await createTemporaryStateFixture()
  observedAt = new Date("2026-08-01T01:00:00.000Z")
  repository = repositoryFor({
    identity: OWNER_ONE,
    ownerToken: OWNER_TOKEN_ONE,
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fixture.cleanup()
})

describe("PendingCommandAttemptCoordinator", () => {
  it("writes a strict secret-free sidecar with 0700/0600 permissions", async () => {
    const record = await seed()
    const handle = await reserve(record)
    const text = await attemptText(record)
    const parsed = JSON.parse(text) as Record<string, unknown>

    expect(parsePendingCommandAttempt(parsed)).not.toBeNull()
    expect(parsePendingCommandAttempt({ ...parsed, extra: true })).toBeNull()
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "formatVersion",
        "recordId",
        "recordIdentityHash",
        "terminalRecordHash",
        "ownerToken",
        "ownerPid",
        "ownerProcessFingerprint",
        "phase",
        "createdAt",
        "leaseExpiresAt",
        "observedAt",
      ].sort()
    )
    expect(text).not.toContain(KEY)
    expect(text).not.toContain(OWNER_SESSION_TOKEN)
    expect(text).not.toContain(fixture.root)
    expect(
      (await stat(fixture.paths.pendingCommandAttempts)).mode & 0o777
    ).toBe(0o700)
    expect(
      (await stat(repository.attempts.path(handle.attempt.recordId))).mode &
        0o777
    ).toBe(0o600)

    await repository.attempts.release(handle)
  })

  it.each([
    ["short", -1, null],
    ["long", 1, null],
    ["observed_after_lease", 0, 1],
  ] as const)(
    "rejects a %s attempt lease that is not exactly five minutes after observedAt",
    async (_case, leaseOffsetMs, observedAfterLeaseMs) => {
      const record = await seed()
      const handle = await reserve(record)
      const raw = JSON.parse(await attemptText(record)) as Record<
        string,
        unknown
      >
      const leaseExpiresAt = Date.parse(String(raw.leaseExpiresAt))

      const malformed = {
        ...raw,
        leaseExpiresAt: new Date(leaseExpiresAt + leaseOffsetMs).toISOString(),
        ...(observedAfterLeaseMs === null
          ? {}
          : {
              observedAt: new Date(
                leaseExpiresAt + observedAfterLeaseMs
              ).toISOString(),
            }),
      }

      expect(parsePendingCommandAttempt(malformed)).toBeNull()
      await repository.attempts.release(handle)
    }
  )

  it("guards network and local mutation with the exact owner token", async () => {
    const record = await seed()
    const handle = await reserve(record)

    await expect(
      repository.attempts.assertNetworkAllowed(record)
    ).rejects.toBeInstanceOf(PendingCommandAttemptBusyError)
    await expect(
      repository.replaceExact(record, {
        ...record,
        localState: "response_unknown",
      })
    ).rejects.toBeInstanceOf(PendingCommandAttemptBusyError)
    await expect(
      repository.attempts.assertNetworkAllowed(
        record,
        handle.attempt.ownerToken
      )
    ).resolves.toBeUndefined()
    await repository.replaceExact(
      record,
      { ...record, localState: "response_unknown" },
      { attemptOwnerToken: handle.attempt.ownerToken }
    )

    await repository.attempts.release(handle)
  })

  it("keeps valid active attempts out of the frozen pending DTO and reports corruption safely", async () => {
    const record = await seed()
    const handle = await reserve(record)

    const activeScan = await repository.scan()
    expect(activeScan.invalidEntries).toEqual([])
    expect(activeScan.records).toHaveLength(1)
    expect(activeScan.records[0]?.record).toEqual(record)
    expect(activeScan.records[0]).not.toHaveProperty("attempt")

    await fixture.fileSystem.atomicWrite(
      repository.attempts.path(handle.attempt.recordId),
      "{not-json\n"
    )
    const corruptScan = await repository.scan()
    expect(corruptScan.invalidEntries).toEqual([
      { recordId: handle.attempt.recordId, reason: "invalid_json" },
    ])
    expect(JSON.stringify(corruptScan.invalidEntries)).not.toContain(KEY)
    expect(JSON.stringify(corruptScan.invalidEntries)).not.toContain(
      fixture.root
    )
  })

  it("reports an arbitrary sidecar basename as a controlled null recordId", async () => {
    await fixture.fileSystem.atomicWrite(
      join(fixture.paths.pendingCommandAttempts, `${OWNER_SESSION_TOKEN}.json`),
      "{}\n"
    )

    const scan = await repository.scan()

    expect(scan.invalidEntries).toEqual([{ recordId: null, reason: "schema" }])
    expect(JSON.stringify(scan.invalidEntries)).not.toContain(
      OWNER_SESSION_TOKEN
    )
    expect(JSON.stringify(scan.invalidEntries)).not.toContain(fixture.root)
  })

  it("reports a canonical sidecar symlink without following it", async () => {
    if (process.platform === "win32") return
    const recordId = "a".repeat(64)
    const target = join(fixture.root, "attempt-symlink-target")
    await fixture.fileSystem.atomicWrite(target, "{}\n")
    await fixture.fileSystem.ensureDirectory(
      fixture.paths.pendingCommandAttempts
    )
    await symlink(target, repository.attempts.path(recordId))

    expect((await repository.scan()).invalidEntries).toEqual([
      { recordId, reason: "symlink" },
    ])
  })

  it.each([
    ["invalid_json", "{not-json\n"],
    ["schema", "{}\n"],
  ] as const)("reports canonical %s sidecar evidence", async (reason, text) => {
    const recordId = "b".repeat(64)
    await fixture.fileSystem.atomicWrite(
      repository.attempts.path(recordId),
      text
    )

    expect((await repository.scan()).invalidEntries).toEqual([
      { recordId, reason },
    ])
  })

  it("fails loud when a valid sidecar identity does not match pending", async () => {
    const record = await seed()
    const handle = await reserve(record)
    const path = repository.attempts.path(handle.attempt.recordId)
    await fixture.fileSystem.atomicWrite(
      path,
      `${JSON.stringify({
        ...handle.attempt,
        recordIdentityHash: "c".repeat(64),
      })}\n`
    )

    expect((await repository.scan()).invalidEntries).toEqual([
      { recordId: handle.attempt.recordId, reason: "schema" },
    ])
  })

  it("fails loud for a nonterminal orphan sidecar", async () => {
    const record = await seed()
    const handle = await reserve(record)
    await repository.removeExact(record, {
      attemptOwnerToken: handle.attempt.ownerToken,
    })

    expect((await repository.scan()).invalidEntries).toEqual([
      { recordId: handle.attempt.recordId, reason: "schema" },
    ])
    await repository.attempts.release(handle)
  })

  it.each(["same_process", "permission_unknown"] as const)(
    "does not reclaim an expired %s owner",
    async (status) => {
      const record = await seed()
      await reserve(record)
      observedAt = new Date(observedAt.getTime() + 10 * 60 * 1000)
      const contender = repositoryFor({
        identity: OWNER_TWO,
        status,
        ownerToken: OWNER_TOKEN_TWO,
      })

      await expect(
        contender.attempts.reserve({
          expected: record,
          phase: "query_intent",
          observedAt,
          allowReclaim: true,
        })
      ).rejects.toBeInstanceOf(PendingCommandAttemptBusyError)
    }
  )

  it.each(["dead", "reused"] as const)(
    "reclaims an expired %s owner only after lock-free identity probes",
    async (status) => {
      const record = await seed()
      await reserve(record)
      observedAt = new Date(observedAt.getTime() + 10 * 60 * 1000)
      const assertNoKeyLock = async () => {
        await expect(
          fixture.fileSystem.exists(repository.keyLockPath(KEY))
        ).resolves.toBe(false)
      }
      const contender = repositoryFor({
        identity: OWNER_TWO,
        status,
        ownerToken: OWNER_TOKEN_TWO,
        onCurrent: assertNoKeyLock,
        onInspect: assertNoKeyLock,
      })

      const handle = await contender.attempts.reserve({
        expected: record,
        phase: "query_intent",
        observedAt,
        allowReclaim: true,
      })

      expect(handle.attempt).toMatchObject({
        ownerToken: OWNER_TOKEN_TWO,
        ownerPid: OWNER_TWO.pid,
      })
      await contender.attempts.release(handle)
    }
  )

  it("recovers the response-loss window with one natural GET then the original POST", async () => {
    const record = await seed()
    const crashedHandle = await reserve(record, "post_dispatch_intent")
    const sidecarPath = repository.attempts.path(crashedHandle.attempt.recordId)
    const postIntentBytes = await fixture.fileSystem.readSecureFile(sidecarPath)
    expect(postIntentBytes).not.toBeNull()
    const write = fixture.fileSystem.atomicWrite.bind(fixture.fileSystem)
    const writeSpy = vi
      .spyOn(fixture.fileSystem, "atomicWrite")
      .mockImplementation((path, text) =>
        path === sidecarPath && text.includes("terminal_cleanup_intent")
          ? Promise.reject(new Error("crash before terminal intent"))
          : write(path, text)
      )
    await expect(
      settlePendingCommand(
        repository,
        record,
        { kind: "not_created" },
        { attemptOwnerToken: crashedHandle.attempt.ownerToken }
      )
    ).rejects.toThrow("crash before terminal intent")
    writeSpy.mockRestore()
    expect(await fixture.fileSystem.readSecureFile(sidecarPath)).toBe(
      postIntentBytes
    )

    observedAt = new Date(observedAt.getTime() + 10 * 60 * 1000)
    const recoveryRepository = repositoryFor({
      identity: OWNER_TWO,
      status: "dead",
      ownerToken: OWNER_TOKEN_TWO,
    })
    const located = {
      index: validTokenIndex(),
      token: OWNER_SESSION_TOKEN,
      credentials: validCredentialMetadata(),
      device: null,
      identity: {
        environment: "production" as const,
        issuerOrigin: "https://api.adrate.io" as const,
        clientInstanceId: "22222222-2222-4222-8222-222222222222",
        tokenGeneration: "44444444-4444-4444-8444-444444444444",
        deviceGeneration: null,
        issueOwnerToken: null,
        pollOwnerToken: null,
      },
    }
    const notFound: PublicResponse = {
      response: {
        status: 404,
        requestId: "stale_recovery_get",
        headers: {
          "content-type": "application/json",
          "x-request-id": "stale_recovery_get",
        },
        text: "{}",
      },
      envelope: {
        ok: false,
        error: {
          code: "RESOURCE_NOT_FOUND",
          message: "Command not found.",
          retryable: false,
          details: { suggestedAction: null, resolutionUrl: null },
        },
        meta: { requestId: "stale_recovery_get", apiVersion: "v1" },
      },
      retryAfterSeconds: null,
    }
    const pending: PublicResponse = {
      response: {
        status: 202,
        requestId: "stale_recovery_post",
        headers: {
          "content-type": "application/json",
          "x-request-id": "stale_recovery_post",
        },
        text: "{}",
      },
      envelope: {
        ok: true,
        data: {
          command: {
            commandId: "018f15d1-7d8f-7ea1-a492-8b7f8271fc6e",
            idempotencyKey: KEY,
            capabilityId: "ads.campaign.status.write",
            status: "pending",
            isFinal: false,
            reason: null,
            suggestedAction: "query_command",
            target: {
              advertiserId: "70001",
              campaignId: "80001",
              desiredStatus: "ENABLE",
            },
            beforeStatus: null,
            afterStatus: null,
            verificationBasis: null,
            attemptCount: 0,
            createdAt: CREATED_AT.toISOString(),
            startedAt: null,
            completedAt: null,
            recoverableUntil: "2026-08-02T00:00:00.000Z",
            lastReconcileAt: null,
          },
        },
        meta: { requestId: "stale_recovery_post", apiVersion: "v1" },
      },
      retryAfterSeconds: null,
    }
    const requestPublic = vi.fn(() => Promise.resolve(notFound))
    const postPublicJson = vi.fn(() => Promise.resolve(pending))
    const http = {
      requestPublic,
      postPublicJson,
    } as unknown as PublicHttpClient
    const local = {
      requireLocated: () => Promise.resolve(located),
      fenceExpectedLocatedCredential: () =>
        Promise.resolve(OWNER_SESSION_TOKEN),
    } as unknown as LocalCredentialCoordinator
    const now = () => new Date(observedAt)
    const query = new CommandQueryService(http, local, recoveryRepository, {
      now,
      environment: {},
    })
    const dispatcher = new StatusCommandDispatcher(
      http,
      recoveryRepository,
      local,
      { now, environment: {} }
    )
    const service = new CommandResumeService(local, recoveryRepository, {
      now,
      query,
      dispatcher,
    })

    await expect(
      service.resume({
        idempotencyKey: KEY,
        requestId: "stale_recovery_client",
      })
    ).resolves.toMatchObject({ exitCode: 0 })
    expect(requestPublic).toHaveBeenCalledTimes(1)
    expect(requestPublic).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        issuerOrigin: "https://api.adrate.io",
        path: `/public/v1/commands?idempotencyKey=${KEY}`,
        token: OWNER_SESSION_TOKEN,
        requestId: "stale_recovery_client",
      })
    )
    expect(postPublicJson).toHaveBeenCalledTimes(1)
    expect(postPublicJson).toHaveBeenCalledWith({
      issuerOrigin: "https://api.adrate.io",
      path: "/public/v1/ads/advertisers/70001/campaigns/80001/status",
      token: OWNER_SESSION_TOKEN,
      idempotencyKey: KEY,
      json: { desiredStatus: "ENABLE" },
      requestId: "stale_recovery_client",
    })
    expect(await recoveryRepository.read(KEY)).toMatchObject({
      kind: "found",
      record: {
        localState: "command_known",
        commandId: "018f15d1-7d8f-7ea1-a492-8b7f8271fc6e",
      },
    })
    expect(await fixture.fileSystem.readSecureFile(sidecarPath)).toBeNull()
  })

  it("rejects clock rollback below a persisted observation before probing", async () => {
    const record = await seed()
    observedAt = new Date("2026-08-03T00:00:00.000Z")
    await reserve(record)
    observedAt = new Date("2026-08-02T00:00:00.000Z")
    const inspect = vi.fn(() => Promise.resolve("dead" as const))
    const contender = new PendingCommandRepository(
      fixture.fileSystem,
      fixture.paths,
      {
        now: () => new Date(observedAt),
        processIdentity: {
          current: () => Promise.resolve(OWNER_TWO),
          inspect,
        },
        generateAttemptOwnerToken: () => OWNER_TOKEN_TWO,
      }
    )

    await expect(
      contender.attempts.reserve({
        expected: record,
        phase: "query_intent",
        observedAt,
        allowReclaim: true,
      })
    ).rejects.toBeInstanceOf(PendingCommandClockRollbackError)
    expect(inspect).not.toHaveBeenCalled()
  })

  it("rereads the exact candidate under lock and rejects an ABA replacement", async () => {
    const record = await seed()
    await reserve(record)
    observedAt = new Date(observedAt.getTime() + 10 * 60 * 1000)
    const sidecarPath = repository.attempts.path(
      (await repository.read(KEY)).recordId
    )
    const contender = repositoryFor({
      identity: OWNER_TWO,
      status: "dead",
      ownerToken: OWNER_TOKEN_TWO,
      onInspect: async () => {
        const text = await fixture.fileSystem.readSecureFile(sidecarPath)
        if (text === null) throw new Error("Expected sidecar")
        const current = parsePendingCommandAttempt(JSON.parse(text))
        if (current === null) throw new Error("Expected valid sidecar")
        await fixture.fileSystem.atomicWrite(
          sidecarPath,
          `${JSON.stringify({
            ...current,
            ownerToken: OWNER_TOKEN_THREE,
            ownerPid: 43_003,
            ownerProcessFingerprint: "test:durable-owner:three",
          })}\n`
        )
      },
    })

    await expect(
      contender.attempts.reserve({
        expected: record,
        phase: "query_intent",
        observedAt,
        allowReclaim: true,
      })
    ).rejects.toBeInstanceOf(PendingCommandAttemptBusyError)
    expect(await fixture.fileSystem.readSecureFile(sidecarPath)).toContain(
      OWNER_TOKEN_THREE
    )
  })

  it("allows one exact query-to-post advance and rejects the same handle again", async () => {
    const record = await seed()
    const queryHandle = await reserve(record)
    const postHandle = await repository.attempts.advanceToPost(
      queryHandle,
      record,
      observedAt
    )

    await expect(
      repository.attempts.advanceToPost(queryHandle, record, observedAt)
    ).rejects.toBeInstanceOf(PendingCommandAttemptBusyError)
    await expect(
      repository.attempts.release(queryHandle)
    ).rejects.toBeInstanceOf(PendingCommandAttemptBusyError)
    expect(
      parsePendingCommandAttempt(JSON.parse(await attemptText(record)))
    ).toMatchObject({ phase: "post_dispatch_intent" })

    await repository.attempts.release(postHandle)
  })

  it("recovers a crash after terminal intent but before pending deletion", async () => {
    const record = await seed()
    const queryHandle = await reserve(record)
    const handle = await repository.attempts.advanceToPost(
      queryHandle,
      record,
      observedAt
    )
    const pendingPath = repository.recordPath(KEY)
    const remove = fixture.fileSystem.removeSecureFile.bind(fixture.fileSystem)
    const removeSpy = vi
      .spyOn(fixture.fileSystem, "removeSecureFile")
      .mockImplementation((path) =>
        path === pendingPath
          ? Promise.reject(new Error("crash before pending delete"))
          : remove(path)
      )

    await expect(
      settlePendingCommand(
        repository,
        record,
        { kind: "final", commandId: "018f15d1-7d8f-7ea1-a492-8b7f8271fc6e" },
        { attemptOwnerToken: handle.attempt.ownerToken }
      )
    ).rejects.toThrow("crash before pending delete")
    removeSpy.mockRestore()

    expect(await repository.read(KEY)).toMatchObject({ kind: "found" })
    expect(
      parsePendingCommandAttempt(JSON.parse(await attemptText(record)))
    ).toMatchObject({
      phase: "terminal_cleanup_intent",
    })
    await expect(
      repository.attempts.advanceToPost(queryHandle, record, observedAt)
    ).rejects.toBeInstanceOf(PendingCommandAttemptBusyError)
    expect(
      parsePendingCommandAttempt(JSON.parse(await attemptText(record)))
    ).toMatchObject({ phase: "terminal_cleanup_intent" })
    await expect(
      repository.attempts.completeTerminalCleanup(KEY)
    ).resolves.toBe(true)
    expect(await repository.read(KEY)).toMatchObject({ kind: "missing" })
    expect(
      await fixture.fileSystem.readSecureFile(
        repository.attempts.path(handle.attempt.recordId)
      )
    ).toBeNull()
  })

  it("recovers a crash after pending deletion but before sidecar deletion", async () => {
    const record = await seed()
    const handle = await reserve(record, "post_dispatch_intent")

    await expect(
      settlePendingCommand(
        repository,
        record,
        { kind: "not_created" },
        { attemptOwnerToken: handle.attempt.ownerToken }
      )
    ).resolves.toBe("applied")

    expect(await repository.read(KEY)).toMatchObject({ kind: "missing" })
    const sidecar = parsePendingCommandAttempt(
      JSON.parse(
        (await fixture.fileSystem.readSecureFile(
          repository.attempts.path(handle.attempt.recordId)
        ))!
      )
    )
    expect(sidecar).toMatchObject({ phase: "terminal_cleanup_intent" })
    await expect(
      repository.attempts.completeTerminalCleanup(KEY)
    ).resolves.toBe(true)
    expect(
      await fixture.fileSystem.readSecureFile(
        repository.attempts.path(handle.attempt.recordId)
      )
    ).toBeNull()
  })

  it.each(["pending_present", "pending_missing"] as const)(
    "Resume completes %s terminal cleanup with zero credential, GET, or POST",
    async (state) => {
      const record = await seed()
      const handle = await reserve(record, "post_dispatch_intent")
      const pendingPath = repository.recordPath(KEY)
      if (state === "pending_present") {
        const remove = fixture.fileSystem.removeSecureFile.bind(
          fixture.fileSystem
        )
        const removeSpy = vi
          .spyOn(fixture.fileSystem, "removeSecureFile")
          .mockImplementation((path) =>
            path === pendingPath
              ? Promise.reject(new Error("simulated crash"))
              : remove(path)
          )
        await expect(
          settlePendingCommand(
            repository,
            record,
            { kind: "not_created" },
            { attemptOwnerToken: handle.attempt.ownerToken }
          )
        ).rejects.toThrow("simulated crash")
        removeSpy.mockRestore()
      } else {
        await settlePendingCommand(
          repository,
          record,
          { kind: "not_created" },
          { attemptOwnerToken: handle.attempt.ownerToken }
        )
      }
      const requireLocated = vi.fn(() =>
        Promise.resolve({
          credentials: validCredentialMetadata(),
          token: OWNER_SESSION_TOKEN,
        })
      )
      const get = vi.fn()
      const dispatch = vi.fn()
      const service = new CommandResumeService(
        { requireLocated } as unknown as LocalCredentialCoordinator,
        repository,
        { query: { get }, dispatcher: { dispatch }, now: () => observedAt }
      )

      let failure: unknown
      try {
        await service.resume({ idempotencyKey: KEY })
      } catch (error) {
        failure = error
      }

      expect(failure).toBeInstanceOf(CliFailure)
      expect(failure).toMatchObject({
        exitCode: 2,
        envelope: {
          error: {
            details: { reason: "pending_command_terminal_cleanup_completed" },
          },
        },
      })
      expect(requireLocated).not.toHaveBeenCalled()
      expect(get).not.toHaveBeenCalled()
      expect(dispatch).not.toHaveBeenCalled()
      expect(await repository.read(KEY)).toMatchObject({ kind: "missing" })
      expect(
        await fixture.fileSystem.readSecureFile(
          repository.attempts.path(handle.attempt.recordId)
        )
      ).toBeNull()
    }
  )

  it("cleans an orphan terminal sidecar before recreating the same Key", async () => {
    const record = await seed()
    const handle = await reserve(record, "post_dispatch_intent")
    await settlePendingCommand(
      repository,
      record,
      { kind: "not_created" },
      { attemptOwnerToken: handle.attempt.ownerToken }
    )
    expect(await repository.scan()).toEqual({
      records: [],
      invalidEntries: [],
    })

    const recreated = await repository.prepare({
      idempotencyKey: KEY,
      credentialId: CREDENTIAL_ID,
      issuerOrigin: "https://api.adrate.io",
      teamId: 42,
      intent: record.intent,
      now: new Date(observedAt),
    })

    expect(recreated.kind).toBe("created")
    expect((await repository.scan()).invalidEntries).toEqual([])
    expect(
      await fixture.fileSystem.readSecureFile(
        repository.attempts.path(handle.attempt.recordId)
      )
    ).toBeNull()
  })
})
