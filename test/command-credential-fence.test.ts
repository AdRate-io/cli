import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AuthCleanupCoordinator } from "../src/auth/auth-cleanup-coordinator.js"
import { LocalCredentialCoordinator } from "../src/auth/local-credentials.js"
import { PendingCommandRepository } from "../src/commands/pending-command-repository.js"
import { StatusCommandDispatcher } from "../src/commands/status-command-dispatcher.js"
import { CliFailure } from "../src/errors.js"
import { CredentialStore } from "../src/storage/credential-backend.js"
import { CliStateStore } from "../src/storage/state-store.js"
import { SecureFileSystem } from "../src/storage/secure-files.js"
import {
  CREDENTIAL_ID,
  OWNER_SESSION_TOKEN,
  createTemporaryStateFixture,
  deferred,
  stableTestProcessIdentity,
  validAuthCleanupReservation,
  validCredentialMetadata,
  validTokenIndex,
} from "./helpers.js"
import type { CliEnvelope } from "../src/contracts/envelope.js"
import type { PublicHttpClient, PublicResponse } from "../src/http/client.js"
import type {
  CredentialAddress,
  CredentialBackend,
} from "../src/storage/credential-backend.js"
import type {
  CredentialMetadata,
  TokenIndex,
  TokenStorageKind,
} from "../src/storage/schemas.js"
import type { TemporaryStateFixture } from "./helpers.js"

const NOW = new Date("2026-07-31T08:00:00.000Z")
const KEY = "credential-fence-key"
const COMMAND_ID = "018f15d1-7d8f-7ea1-a492-8b7f8271fc6e"

function addressKey(address: CredentialAddress): string {
  return `${address.issuerOrigin}|${address.credentialKind}|${address.credentialId}`
}

class MemoryCredentialBackend implements CredentialBackend {
  readonly values = new Map<string, string>()

  constructor(readonly kind: TokenStorageKind) {}

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }

  read(address: CredentialAddress): Promise<string | null> {
    return Promise.resolve(this.values.get(addressKey(address)) ?? null)
  }

  write(address: CredentialAddress, token: string): Promise<void> {
    this.values.set(addressKey(address), token)
    return Promise.resolve()
  }

  remove(address: CredentialAddress): Promise<void> {
    this.values.delete(addressKey(address))
    return Promise.resolve()
  }
}

interface FenceHarness {
  state: CliStateStore
  local: LocalCredentialCoordinator
  keychain: MemoryCredentialBackend
  repository: PendingCommandRepository
  index: TokenIndex
  metadata: CredentialMetadata
  located: Awaited<ReturnType<LocalCredentialCoordinator["requireLocated"]>>
  record: Awaited<ReturnType<PendingCommandRepository["prepare"]>> & {
    kind: "created"
  }
}

async function createHarness(
  fixture: TemporaryStateFixture
): Promise<FenceHarness> {
  const state = new CliStateStore(fixture.fileSystem, fixture.paths)
  const keychain = new MemoryCredentialBackend("keychain")
  const credentials = new CredentialStore(
    keychain,
    new MemoryCredentialBackend("fallback_file")
  )
  const local = new LocalCredentialCoordinator(state, credentials)
  let index!: TokenIndex
  let metadata!: CredentialMetadata
  await state.withAuthLock(async () => {
    const config = await state.ensureConfig("production")
    index = validTokenIndex({ clientInstanceId: config.clientInstanceId })
    metadata = validCredentialMetadata({
      clientInstanceId: config.clientInstanceId,
    })
    await state.writeTokenIndex(index)
    await state.writeCredentials(metadata)
  })
  await credentials.write(index, OWNER_SESSION_TOKEN)
  const located = await local.requireLocated()
  const repository = new PendingCommandRepository(
    fixture.fileSystem,
    fixture.paths,
    {
      now: () => new Date(NOW),
      processIdentity: stableTestProcessIdentity("credential-fence"),
    }
  )
  const record = await repository.prepare({
    idempotencyKey: KEY,
    credentialId: CREDENTIAL_ID,
    issuerOrigin: "https://api.adrate.io",
    teamId: 42,
    intent: {
      advId: "70001",
      campaignId: "80001",
      desiredStatus: "ENABLE",
      authId: null,
    },
    now: NOW,
  })
  if (record.kind !== "created") throw new Error("Expected pending record")
  return {
    state,
    local,
    keychain,
    repository,
    index,
    metadata,
    located,
    record,
  }
}

function pendingResponse(): PublicResponse {
  return {
    response: {
      status: 202,
      requestId: "credential_fence_server",
      headers: {
        "content-type": "application/json",
        "x-request-id": "credential_fence_server",
      },
      text: "{}",
    },
    envelope: {
      ok: true,
      data: {
        command: {
          commandId: COMMAND_ID,
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
          createdAt: NOW.toISOString(),
          startedAt: null,
          completedAt: null,
          recoverableUntil: "2026-08-01T08:00:00.000Z",
          lastReconcileAt: null,
        },
      },
      meta: { requestId: "credential_fence_server", apiVersion: "v1" },
    },
    retryAfterSeconds: null,
  }
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
  throw new Error("Expected credential fence failure")
}

let fixture: TemporaryStateFixture
let harness: FenceHarness

beforeEach(async () => {
  fixture = await createTemporaryStateFixture()
  harness = await createHarness(fixture)
})

afterEach(async () => {
  await fixture.cleanup()
})

describe("Status POST credential identity fence", () => {
  it.each(["generation", "staging", "token", "team", "cleanup"] as const)(
    "blocks %s drift before entering the unique POST action",
    async (drift) => {
      if (drift === "generation") {
        await harness.state.withAuthLock(() =>
          harness.state.writeTokenIndex({
            ...harness.index,
            generation: "77777777-7777-4777-8777-777777777777",
          })
        )
      } else if (drift === "staging") {
        await harness.state.withAuthLock(() =>
          harness.state.writeTokenIndex({
            ...harness.index,
            state: "staging",
            storageCommit: {
              transactionId: "88888888-8888-4888-8888-888888888888",
              ownerPid: 123,
              ownerProcessFingerprint: "staging-test-owner",
              leaseExpiresAt: "2026-07-31T08:10:00.000Z",
            },
          })
        )
      } else if (drift === "token") {
        await harness.keychain.write(
          harness.local.credentials.addressFor(harness.index),
          `adr_owner_${CREDENTIAL_ID}_${"B".repeat(43)}`
        )
      } else if (drift === "team") {
        await harness.state.withAuthLock(() =>
          harness.state.writeCredentials({
            ...harness.metadata,
            teamId: 99,
          })
        )
      } else {
        await harness.state.withAuthLock(() =>
          harness.state.writeAuthCleanupReservation(
            validAuthCleanupReservation({
              credentialLocator: {
                issuerOrigin: harness.index.issuerOrigin,
                credentialKind: harness.index.credentialKind,
                credentialId: harness.index.credentialId,
                storageKind: harness.index.storageKind,
              },
              expectedClientInstanceId: harness.index.clientInstanceId,
              expectedDeviceGeneration: null,
              expectedPollOwnerToken: null,
            })
          )
        )
      }
      const postPublicJson = vi.fn(() => Promise.resolve(pendingResponse()))
      const dispatcher = new StatusCommandDispatcher(
        { postPublicJson } as unknown as PublicHttpClient,
        harness.repository,
        harness.local,
        { now: () => NOW }
      )

      const failure = await failureFrom(
        dispatcher.dispatch({
          record: harness.record.record,
          expectedCredential: harness.located,
        })
      )

      expect(failure).toMatchObject({
        exitCode: 4,
        envelope: {
          error: {
            code: "DEPENDENCY_UNAVAILABLE",
            retryable: true,
            details: { localStateChanged: true },
          },
        },
      })
      expect(postPublicJson).not.toHaveBeenCalled()
      expect(await harness.repository.read(KEY)).toMatchObject({
        kind: "found",
        record: { localState: "prepared" },
      })
    }
  )

  it("keeps a slow frozen-locator Token read outside the auth lock", async () => {
    const originalRead = harness.keychain.read.bind(harness.keychain)
    const tokenReadEntered = deferred()
    const releaseTokenRead = deferred()
    vi.spyOn(harness.keychain, "read").mockImplementationOnce(
      async (address) => {
        tokenReadEntered.resolve()
        await releaseTokenRead.promise
        return originalRead(address)
      }
    )
    const postPublicJson = vi.fn(() => Promise.resolve(pendingResponse()))
    const dispatcher = new StatusCommandDispatcher(
      { postPublicJson } as unknown as PublicHttpClient,
      harness.repository,
      harness.local,
      { now: () => NOW }
    )

    const dispatch = dispatcher.dispatch({
      record: harness.record.record,
      expectedCredential: harness.located,
    })
    await tokenReadEntered.promise

    const peerState = new CliStateStore(
      new SecureFileSystem({ root: fixture.root }),
      fixture.paths
    )
    await expect(
      peerState.withAuthLock(() => Promise.resolve("peer-entered"))
    ).resolves.toBe("peer-entered")

    releaseTokenRead.resolve()
    await expect(dispatch).resolves.toMatchObject({ exitCode: 0 })
    expect(postPublicJson).toHaveBeenCalledTimes(1)
  })

  it("releases the auth lock before the real POST so cleanup is not network-blocked", async () => {
    const postEntered = deferred()
    const releasePost = deferred()
    const postPublicJson = vi.fn(async () => {
      postEntered.resolve()
      await releasePost.promise
      return pendingResponse()
    })
    const dispatcher = new StatusCommandDispatcher(
      { postPublicJson } as unknown as PublicHttpClient,
      harness.repository,
      harness.local,
      { now: () => NOW }
    )

    const dispatch = dispatcher.dispatch({
      record: harness.record.record,
      expectedCredential: harness.located,
    })
    await postEntered.promise

    const logoutCleanup = new AuthCleanupCoordinator(harness.local, () => NOW)
    await expect(
      logoutCleanup.clearIfUnchanged(harness.located.identity)
    ).resolves.toBe("cleared")

    releasePost.resolve()
    await expect(dispatch).resolves.toMatchObject({ exitCode: 0 })
    expect(postPublicJson).toHaveBeenCalledTimes(1)
    expect(await harness.local.captureIdentity()).toMatchObject({
      tokenGeneration: null,
    })
  })

  it("sends zero POST while a peer login/logout transition already owns auth lock", async () => {
    const peerState = new CliStateStore(
      new SecureFileSystem({ root: fixture.root }),
      fixture.paths
    )
    const lockEntered = deferred()
    const releaseLock = deferred()
    const holder = peerState.withAuthLock(async () => {
      lockEntered.resolve()
      await releaseLock.promise
    })
    await lockEntered.promise
    const postPublicJson = vi.fn(() => Promise.resolve(pendingResponse()))
    const dispatcher = new StatusCommandDispatcher(
      { postPublicJson } as unknown as PublicHttpClient,
      harness.repository,
      harness.local,
      { now: () => NOW }
    )

    const failure = await failureFrom(
      dispatcher.dispatch({
        record: harness.record.record,
        expectedCredential: harness.located,
      })
    )

    expect(failure).toMatchObject({
      exitCode: 4,
      envelope: {
        error: { code: "DEPENDENCY_UNAVAILABLE", retryable: true },
      },
    })
    expect(postPublicJson).not.toHaveBeenCalled()
    releaseLock.resolve()
    await holder
  })
})
