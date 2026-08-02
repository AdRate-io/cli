import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CommandResumeService } from "../src/commands/command-resume-service.js"
import { PendingCommandRepository } from "../src/commands/pending-command-repository.js"
import { serializePendingCommand } from "../src/commands/pending-command-contract.js"
import { CliFailure } from "../src/errors.js"
import {
  CREDENTIAL_ID,
  OWNER_SESSION_TOKEN,
  createTemporaryStateFixture,
  validCredentialMetadata,
  validTokenIndex,
} from "./helpers.js"
import type {
  LocalCredentialCoordinator,
  LocatedCredential,
} from "../src/auth/local-credentials.js"
import type { CliEnvelope } from "../src/contracts/envelope.js"
import type {
  PendingCommandLocalState,
  PendingCommandRecord,
} from "../src/commands/pending-command-contract.js"
import type { TemporaryStateFixture } from "./helpers.js"

const NOW = new Date("2026-08-02T00:00:00.000Z")
const DEFAULT_CREATED_AT = "2026-08-01T00:00:00.000Z"
const DAY_MS = 86_400_000
const OLD_CREDENTIAL_ID = "77777777-7777-4777-8777-777777777777"

function locatedCredential(
  input: {
    credentialId?: string
    issuerOrigin?: "https://api.adrate.io" | "https://api.test.adrate.io"
    teamId?: number
    activated?: boolean
  } = {}
): LocatedCredential {
  const credentialId = input.credentialId ?? CREDENTIAL_ID
  const issuerOrigin = input.issuerOrigin ?? "https://api.adrate.io"
  const environment =
    issuerOrigin === "https://api.adrate.io" ? "production" : "test"
  return {
    index: validTokenIndex({ credentialId, issuerOrigin, environment }),
    token: OWNER_SESSION_TOKEN,
    credentials:
      input.activated === false
        ? null
        : validCredentialMetadata({
            credentialId,
            issuerOrigin,
            teamId: input.teamId ?? 42,
          }),
    device: null,
    identity: {
      environment,
      issuerOrigin,
      clientInstanceId: "22222222-2222-4222-8222-222222222222",
      tokenGeneration: "44444444-4444-4444-8444-444444444444",
      deviceGeneration: null,
      issueOwnerToken: null,
      pollOwnerToken: null,
    },
  }
}

function localMock(
  located = locatedCredential(),
  events?: Array<string>
): {
  local: LocalCredentialCoordinator
  requireLocated: ReturnType<typeof vi.fn>
} {
  const requireLocated = vi.fn(() => {
    events?.push("credential")
    return Promise.resolve(located)
  })
  return {
    requireLocated,
    local: { requireLocated } as unknown as LocalCredentialCoordinator,
  }
}

interface SeedInput {
  key: string
  createdAt?: string
  credentialId?: string
  issuerOrigin?: "https://api.adrate.io" | "https://api.test.adrate.io"
  teamId?: number
  localState?: PendingCommandLocalState
}

let fixture: TemporaryStateFixture
let repository: PendingCommandRepository

async function seed(input: SeedInput) {
  const created = await repository.prepare({
    idempotencyKey: input.key,
    credentialId: input.credentialId ?? CREDENTIAL_ID,
    issuerOrigin: input.issuerOrigin ?? "https://api.adrate.io",
    teamId: input.teamId ?? 42,
    intent: {
      advId: "70001",
      campaignId: "80001",
      desiredStatus: "ENABLE",
      authId: 9,
    },
    now: new Date(input.createdAt ?? DEFAULT_CREATED_AT),
  })
  if (created.kind !== "created") {
    throw new Error(`Unexpected prepare result: ${created.kind}`)
  }
  const next: PendingCommandRecord = {
    ...created.record,
    localState: input.localState ?? "prepared",
  }
  if (
    serializePendingCommand(next) !== serializePendingCommand(created.record)
  ) {
    await repository.replaceExact(created.record, next)
  }
  return { recordId: created.recordId, record: next }
}

async function failureFrom(
  promise: Promise<unknown>
): Promise<CliFailure<CliEnvelope>> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(CliFailure)
    return error as CliFailure<CliEnvelope>
  }
  throw new Error("Expected CommandResumeService.qualify() to fail")
}

beforeEach(async () => {
  fixture = await createTemporaryStateFixture()
  repository = new PendingCommandRepository(fixture.fileSystem, fixture.paths)
})

afterEach(async () => {
  await fixture.cleanup()
})

describe("CommandResumeService.qualify", () => {
  it("validates before scan or credential access", async () => {
    const local = localMock()
    const scan = vi.spyOn(repository, "scan")
    const service = new CommandResumeService(local.local, repository)

    const failure = await failureFrom(
      service.qualify({ idempotencyKey: "../secret" })
    )

    expect(failure.exitCode).toBe(2)
    expect(scan).not.toHaveBeenCalled()
    expect(local.requireLocated).not.toHaveBeenCalled()
  })

  it("fails a damaged full scan before clock or credential and hides its filename", async () => {
    await seed({ key: "resume-key" })
    const secretPath = join(
      fixture.paths.pendingCommands,
      `${OWNER_SESSION_TOKEN}.json`
    )
    await fixture.fileSystem.atomicWrite(secretPath, "{}")
    const local = localMock()
    const now = vi.fn(() => NOW)
    const service = new CommandResumeService(local.local, repository, { now })

    const failure = await failureFrom(
      service.qualify({ idempotencyKey: "resume-key" })
    )
    const serialized = JSON.stringify(failure.envelope)

    expect(failure.exitCode).toBe(1)
    expect(now).not.toHaveBeenCalled()
    expect(local.requireLocated).not.toHaveBeenCalled()
    expect(serialized).not.toContain(OWNER_SESSION_TOKEN)
    expect(serialized).not.toContain(fixture.root)
    expect(await fixture.fileSystem.exists(secretPath)).toBe(true)
  })

  it.each([
    ["expired_unsubmitted", 1, "LOCAL_STATE_UNSAFE"],
    ["orphaned_credential", 3, "LOCAL_CREDENTIAL_MISMATCH"],
  ] as const)(
    "permanently blocks %s before clock or credential",
    async (localState, exitCode, errorCode) => {
      const seeded = await seed({ key: "blocked-key", localState })
      const before = await repository.read("blocked-key")
      const local = localMock()
      const now = vi.fn(() => NOW)
      const service = new CommandResumeService(local.local, repository, { now })

      const failure = await failureFrom(
        service.qualify({ idempotencyKey: "blocked-key" })
      )

      expect(failure.exitCode).toBe(exitCode)
      expect(failure.envelope).toMatchObject({
        ok: false,
        error: {
          code: errorCode,
          details: { recordId: seeded.recordId, blockedReason: localState },
        },
      })
      expect(now).not.toHaveBeenCalled()
      expect(local.requireLocated).not.toHaveBeenCalled()
      expect(await repository.read("blocked-key")).toEqual(before)
    }
  )

  it("rejects a future createdAt before credential access", async () => {
    const createdAt = new Date(NOW.getTime() + 1).toISOString()
    await seed({ key: "future-key", createdAt })
    const local = localMock()
    const service = new CommandResumeService(local.local, repository, {
      now: () => NOW,
    })

    const failure = await failureFrom(
      service.qualify({ idempotencyKey: "future-key" })
    )

    expect(failure.exitCode).toBe(1)
    expect(failure.envelope).toMatchObject({
      ok: false,
      error: {
        code: "LOCAL_STATE_UNSAFE",
        details: { reason: "invalid_created_at" },
      },
    })
    expect(local.requireLocated).not.toHaveBeenCalled()
  })

  it("rejects an invalid clock before credential access", async () => {
    await seed({ key: "clock-key" })
    const local = localMock()
    const service = new CommandResumeService(local.local, repository, {
      now: () => new Date(Number.NaN),
    })

    const failure = await failureFrom(
      service.qualify({ idempotencyKey: "clock-key" })
    )

    expect(failure.exitCode).toBe(1)
    expect(failure.envelope).toMatchObject({
      ok: false,
      error: {
        code: "LOCAL_STATE_UNSAFE",
        details: { reason: "invalid_clock" },
      },
    })
    expect(local.requireLocated).not.toHaveBeenCalled()
  })

  it.each([
    ["before 24h", DAY_MS - 1],
    ["at 24h", DAY_MS],
    ["after 24h", DAY_MS + 1],
  ])(
    "only preserves time facts %s without an age decision",
    async (_label, age) => {
      const events: Array<string> = []
      const createdAt = new Date(NOW.getTime() - age).toISOString()
      const seeded = await seed({ key: "boundary-key", createdAt })
      const before = await repository.read("boundary-key")
      const located = locatedCredential()
      const local = localMock(located, events)
      const scan = repository.scan.bind(repository)
      vi.spyOn(repository, "scan").mockImplementation(() => {
        events.push("scan")
        return scan()
      })
      const service = new CommandResumeService(local.local, repository, {
        now: () => {
          events.push("clock")
          return NOW
        },
      })

      const qualified = await service.qualify({
        idempotencyKey: "boundary-key",
        requestId: "client_resume_1",
      })

      expect(Object.keys(qualified).sort()).toEqual(
        ["entry", "located", "observedAt", "requestId"].sort()
      )
      expect(Object.isFrozen(qualified)).toBe(true)
      expect(qualified.entry).toMatchObject({
        recordId: seeded.recordId,
        record: {
          idempotencyKey: "boundary-key",
          createdAt,
          intent: seeded.record.intent,
        },
      })
      expect(qualified.located).toBe(located)
      expect(qualified.requestId).toBe("client_resume_1")
      expect(events).toEqual(["scan", "clock", "credential"])
      expect(await repository.read("boundary-key")).toEqual(before)
    }
  )

  it("requires activated credential metadata after local time checks", async () => {
    await seed({ key: "unactivated-key" })
    const local = localMock(locatedCredential({ activated: false }))
    const service = new CommandResumeService(local.local, repository, {
      now: () => NOW,
    })

    const failure = await failureFrom(
      service.qualify({ idempotencyKey: "unactivated-key" })
    )

    expect(failure.exitCode).toBe(3)
    expect(local.requireLocated).toHaveBeenCalledTimes(1)
    expect((await repository.read("unactivated-key")).kind).toBe("found")
  })

  it.each([
    ["credential", { credentialId: OLD_CREDENTIAL_ID }],
    ["issuer", { issuerOrigin: "https://api.test.adrate.io" as const }],
    ["team", { teamId: 7 }],
  ])(
    "CAS-blocks a prior %s scope and then blocks idempotently",
    async (_label, scope) => {
      const seeded = await seed({ key: "old-scope-key", ...scope })
      const local = localMock()
      const now = vi.fn(() => NOW)
      const service = new CommandResumeService(local.local, repository, { now })

      const first = await failureFrom(
        service.qualify({ idempotencyKey: "old-scope-key" })
      )
      const afterFirst = await repository.read("old-scope-key")
      const second = await failureFrom(
        service.qualify({ idempotencyKey: "old-scope-key" })
      )

      expect(first.exitCode).toBe(3)
      expect(second.exitCode).toBe(3)
      expect(first.envelope).toMatchObject({
        ok: false,
        error: { code: "LOCAL_CREDENTIAL_MISMATCH" },
      })
      expect(afterFirst).toMatchObject({
        kind: "found",
        record: {
          localState: "orphaned_credential",
          credentialId: seeded.record.credentialId,
          issuerOrigin: seeded.record.issuerOrigin,
          teamId: seeded.record.teamId,
        },
      })
      expect(await repository.read("old-scope-key")).toEqual(afterFirst)
      expect(local.requireLocated).toHaveBeenCalledTimes(1)
      expect(now).toHaveBeenCalledTimes(1)
    }
  )

  it("preserves newer evidence and fails loud when orphan CAS loses", async () => {
    const seeded = await seed({
      key: "cas-key",
      credentialId: OLD_CREDENTIAL_ID,
    })
    const local = localMock()
    const replaceExact = repository.replaceExact.bind(repository)
    vi.spyOn(repository, "replaceExact").mockImplementationOnce(
      async (expected, next) => {
        await replaceExact(expected, {
          ...expected,
          localState: "response_unknown",
          updatedAt: "2026-08-01T12:00:00.000Z",
        })
        await replaceExact(expected, next)
      }
    )
    const service = new CommandResumeService(local.local, repository, {
      now: () => NOW,
    })

    const failure = await failureFrom(
      service.qualify({ idempotencyKey: "cas-key" })
    )
    const after = await repository.read("cas-key")

    expect(failure.exitCode).toBe(4)
    expect(failure.envelope).toMatchObject({
      ok: false,
      error: {
        code: "DEPENDENCY_UNAVAILABLE",
        details: { recordId: seeded.recordId },
      },
    })
    expect(after).toMatchObject({
      kind: "found",
      record: {
        localState: "response_unknown",
        updatedAt: "2026-08-01T12:00:00.000Z",
      },
    })
    expect(local.requireLocated).toHaveBeenCalledTimes(1)
  })
})
