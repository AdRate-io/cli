import { afterEach, describe, expect, it } from "vitest"
import { LocalCredentialCoordinator } from "../src/auth/local-credentials.js"
import {
  parseAuthCleanupReservation,
  parseConfig,
  parseCredentialMetadata,
  parseDeviceIssueReservation,
  parseDevicePollAttempt,
  parseDeviceState,
  parseLogoutDeliveryJournal,
  parseTokenIndex,
} from "../src/storage/schemas.js"
import { CliStateStore } from "../src/storage/state-store.js"
import {
  createTemporaryStateFixture,
  validAuthCleanupReservation,
  validConfig,
  validCredentialMetadata,
  validDeviceIssueReservation,
  validDevicePollAttempt,
  validDeviceState,
  validLogoutDeliveryJournal,
  validTokenIndex,
} from "./helpers.js"
import type { TemporaryStateFixture } from "./helpers.js"

let fixture: TemporaryStateFixture | null = null

afterEach(async () => {
  if (fixture) await fixture.cleanup()
  fixture = null
})

function withExtraKey<T extends object>(value: T): T & { unexpected: true } {
  return { ...value, unexpected: true }
}

describe("exact local state schemas", () => {
  it("accepts each frozen schema without normalization", () => {
    const config = validConfig()
    const index = validTokenIndex()
    const metadata = validCredentialMetadata()
    const device = validDeviceState()
    const reservation = validDeviceIssueReservation()
    const pollAttempt = validDevicePollAttempt()
    const cleanup = validAuthCleanupReservation()
    const logoutJournal = validLogoutDeliveryJournal()
    const recordedLogoutJournal = validLogoutDeliveryJournal({
      phase: "outcome_recorded",
      remoteOutcome: "confirmed_inactive",
      reason: "revoked",
      recordedAt: "2026-07-31T08:00:01.000Z",
    })

    expect(parseConfig(config)).toEqual(config)
    expect(parseTokenIndex(index)).toEqual(index)
    expect(parseCredentialMetadata(metadata)).toEqual(metadata)
    expect(parseDeviceState(device)).toEqual(device)
    expect(parseDeviceIssueReservation(reservation)).toEqual(reservation)
    expect(parseDevicePollAttempt(pollAttempt)).toEqual(pollAttempt)
    expect(parseAuthCleanupReservation(cleanup)).toEqual(cleanup)
    expect(parseLogoutDeliveryJournal(logoutJournal)).toEqual(logoutJournal)
    expect(parseLogoutDeliveryJournal(recordedLogoutJournal)).toEqual(
      recordedLogoutJournal
    )
  })

  it("rejects unknown fields for every local state schema", () => {
    expect(parseConfig(withExtraKey(validConfig()))).toBeNull()
    expect(parseTokenIndex(withExtraKey(validTokenIndex()))).toBeNull()
    expect(
      parseCredentialMetadata(withExtraKey(validCredentialMetadata()))
    ).toBeNull()
    expect(parseDeviceState(withExtraKey(validDeviceState()))).toBeNull()
    expect(
      parseDeviceIssueReservation(withExtraKey(validDeviceIssueReservation()))
    ).toBeNull()
    expect(
      parseDevicePollAttempt(withExtraKey(validDevicePollAttempt()))
    ).toBeNull()
    expect(
      parseAuthCleanupReservation(withExtraKey(validAuthCleanupReservation()))
    ).toBeNull()
    expect(
      parseLogoutDeliveryJournal(withExtraKey(validLogoutDeliveryJournal()))
    ).toBeNull()
  })

  it("rejects missing fields and unsupported format versions", () => {
    const config = { ...validConfig() } as Record<string, unknown>
    delete config.clientInstanceId
    expect(parseConfig(config)).toBeNull()
    expect(parseConfig({ ...validConfig(), configFormatVersion: 2 })).toBeNull()

    const index = { ...validTokenIndex() } as Record<string, unknown>
    delete index.storageKind
    expect(parseTokenIndex(index)).toBeNull()
    expect(
      parseTokenIndex({
        ...validTokenIndex(),
        tokenIndexFormatVersion: 2,
      })
    ).toBeNull()

    const metadata = {
      ...validCredentialMetadata(),
    } as Record<string, unknown>
    delete metadata.loggedInAt
    expect(parseCredentialMetadata(metadata)).toBeNull()
    expect(
      parseCredentialMetadata({
        ...validCredentialMetadata(),
        credentialFormatVersion: 2,
      })
    ).toBeNull()

    const device = { ...validDeviceState() } as Record<string, unknown>
    delete device.nextPollAt
    expect(parseDeviceState(device)).toBeNull()
    expect(
      parseDeviceState({ ...validDeviceState(), formatVersion: 2 })
    ).toBeNull()

    const pollAttempt = {
      ...validDevicePollAttempt(),
    } as Record<string, unknown>
    delete pollAttempt.deviceGeneration
    expect(parseDevicePollAttempt(pollAttempt)).toBeNull()

    const cleanup = {
      ...validAuthCleanupReservation(),
    } as Record<string, unknown>
    delete cleanup.expectedTokenGeneration
    expect(parseAuthCleanupReservation(cleanup)).toBeNull()
    expect(
      parseAuthCleanupReservation({
        ...validAuthCleanupReservation(),
        expectedTokenDigest: "not-a-digest",
      })
    ).toBeNull()
    expect(
      parseAuthCleanupReservation({
        ...validAuthCleanupReservation(),
        credentialLocator: null,
      })
    ).toBeNull()

    const logoutJournal = {
      ...validLogoutDeliveryJournal(),
    } as Record<string, unknown>
    delete logoutJournal.requestId
    expect(parseLogoutDeliveryJournal(logoutJournal)).toBeNull()
    expect(
      parseLogoutDeliveryJournal({
        ...validLogoutDeliveryJournal(),
        formatVersion: 2,
      })
    ).toBeNull()
  })

  it("rejects config and reservations whose environment does not match issuer", () => {
    expect(
      parseConfig({
        ...validConfig(),
        environment: "test",
        issuerOrigin: "https://api.adrate.io",
      })
    ).toBeNull()
    expect(
      parseDeviceIssueReservation({
        ...validDeviceIssueReservation(),
        environment: "production",
        issuerOrigin: "https://api.test.adrate.io",
      })
    ).toBeNull()
    expect(
      parseDevicePollAttempt({
        ...validDevicePollAttempt(),
        environment: "test",
      })
    ).toBeNull()
    expect(
      parseAuthCleanupReservation({
        ...validAuthCleanupReservation(),
        expectedEnvironment: "test",
      })
    ).toBeNull()
  })

  it("binds poll phases to a frozen credential backend", () => {
    expect(
      parseDevicePollAttempt(
        validDevicePollAttempt({
          phase: "selecting_backend",
          storageKind: null,
        })
      )
    ).not.toBeNull()
    expect(
      parseDevicePollAttempt(
        validDevicePollAttempt({
          phase: "selecting_backend",
          storageKind: "keychain",
        })
      )
    ).toBeNull()
    expect(
      parseDevicePollAttempt(
        validDevicePollAttempt({ phase: "dispatch_intent", storageKind: null })
      )
    ).toBeNull()
    expect(
      parseDevicePollAttempt(
        validDevicePollAttempt({
          phase: "dispatch_intent",
          dispatchedAt: null,
        })
      )
    ).toBeNull()
    expect(
      parseDevicePollAttempt(
        validDevicePollAttempt({
          phase: "dispatch_intent",
          deliveryVerification: true,
          verificationClaimedAt: "2026-07-31T08:00:01.000Z",
        })
      )
    ).toBeNull()
    expect(
      parseDevicePollAttempt(
        validDevicePollAttempt({
          phase: "dispatch_intent",
          createdAt: "2026-07-31T08:00:02.000Z",
          dispatchedAt: "2026-07-31T08:00:01.000Z",
        })
      )
    ).toBeNull()

    const acknowledged = validDevicePollAttempt({
      phase: "response_acknowledged",
      responseAcknowledgement: {
        responseKind: "temporarily_unavailable",
        responseReceivedAt: "2026-07-31T08:00:01.000Z",
        previousProtocolIntervalSeconds: 5,
        protocolIntervalSeconds: 5,
        retryAfterSeconds: 86_400,
        nextPollAt: "2026-08-01T08:00:01.000Z",
      },
    })
    expect(parseDevicePollAttempt(acknowledged)).toEqual(acknowledged)
    expect(
      parseDevicePollAttempt({
        ...acknowledged,
        responseAcknowledgement: null,
      })
    ).toBeNull()
    expect(
      parseDevicePollAttempt({
        ...validDevicePollAttempt({ phase: "dispatch_intent" }),
        responseAcknowledgement: acknowledged.responseAcknowledgement,
      })
    ).toBeNull()
    expect(
      parseDevicePollAttempt({
        ...acknowledged,
        responseAcknowledgement: {
          ...acknowledged.responseAcknowledgement!,
          responseKind: "unknown_response",
        },
      })
    ).toBeNull()
    expect(
      parseDevicePollAttempt({
        ...acknowledged,
        responseAcknowledgement: {
          ...acknowledged.responseAcknowledgement!,
          responseReceivedAt: "2026-07-31T07:59:59.000Z",
        },
      })
    ).toBeNull()
    expect(
      parseDevicePollAttempt({
        ...acknowledged,
        responseAcknowledgement: {
          ...acknowledged.responseAcknowledgement!,
          nextPollAt: "2026-08-01T08:00:02.000Z",
        },
      })
    ).toBeNull()
    const pendingAcknowledged = validDevicePollAttempt({
      phase: "response_acknowledged",
    })
    expect(
      parseDevicePollAttempt({
        ...pendingAcknowledged,
        responseAcknowledgement: {
          ...pendingAcknowledged.responseAcknowledgement!,
          nextPollAt: "2026-07-31T08:00:07.000Z",
        },
      })
    ).toBeNull()

    const slowDownAcknowledged = validDevicePollAttempt({
      phase: "response_acknowledged",
      responseAcknowledgement: {
        responseKind: "slow_down",
        responseReceivedAt: "2026-07-31T08:00:01.000Z",
        previousProtocolIntervalSeconds: 5,
        protocolIntervalSeconds: 12,
        retryAfterSeconds: 12,
        nextPollAt: "2026-07-31T08:00:13.000Z",
      },
    })
    expect(parseDevicePollAttempt(slowDownAcknowledged)).toEqual(
      slowDownAcknowledged
    )
    const verificationSlowDownWithoutRetryAfter = validDevicePollAttempt({
      phase: "response_acknowledged",
      deliveryVerification: true,
      responseAcknowledgement: {
        responseKind: "slow_down",
        responseReceivedAt: "2026-07-31T08:00:01.000Z",
        previousProtocolIntervalSeconds: 28,
        protocolIntervalSeconds: 30,
        retryAfterSeconds: null,
        nextPollAt: "2026-07-31T08:00:31.000Z",
      },
    })
    expect(
      parseDevicePollAttempt(verificationSlowDownWithoutRetryAfter)
    ).toEqual(verificationSlowDownWithoutRetryAfter)
    expect(
      parseDevicePollAttempt({
        ...verificationSlowDownWithoutRetryAfter,
        deliveryVerification: false,
        verificationClaimedAt: null,
      })
    ).toBeNull()
    expect(
      parseDevicePollAttempt({
        ...slowDownAcknowledged,
        responseAcknowledgement: {
          ...slowDownAcknowledged.responseAcknowledgement!,
          protocolIntervalSeconds: 11,
          nextPollAt: "2026-07-31T08:00:12.000Z",
        },
      })
    ).toBeNull()
    expect(
      parseDevicePollAttempt({
        ...pendingAcknowledged,
        responseAcknowledgement: {
          ...pendingAcknowledged.responseAcknowledgement!,
          retryAfterSeconds: 5,
        },
      })
    ).toBeNull()
    expect(
      parseDevicePollAttempt({
        ...acknowledged,
        responseAcknowledgement: {
          ...acknowledged.responseAcknowledgement!,
          retryAfterSeconds: 600,
        },
      })
    ).toBeNull()
  })

  it("requires staging storage-commit owner identity and scrubs it on stored state", () => {
    const commit = {
      transactionId: "77777777-7777-4777-8777-777777777777",
      ownerPid: 12_345,
      ownerProcessFingerprint: "linux:boot-id:start-ticks",
      leaseExpiresAt: "2026-07-31T08:00:45.000Z",
    }
    expect(
      parseTokenIndex(
        validTokenIndex({ state: "staging", storageCommit: commit })
      )
    ).not.toBeNull()
    expect(
      parseTokenIndex(
        validTokenIndex({ state: "staging", storageCommit: null })
      )
    ).toBeNull()
    expect(
      parseTokenIndex(
        validTokenIndex({ state: "stored", storageCommit: commit })
      )
    ).toBeNull()
    expect(
      parseDevicePollAttempt(validDevicePollAttempt({ ownerPid: 0 }))
    ).toBeNull()
    expect(
      parseDevicePollAttempt(
        validDevicePollAttempt({ ownerProcessFingerprint: "unsafe\nvalue" })
      )
    ).toBeNull()
  })

  it("rejects unknown, loopback, path-bearing, and cross-environment issuers", () => {
    for (const issuerOrigin of [
      "https://unknown.adrate.io",
      "http://127.0.0.1:9527",
      "https://api.adrate.io/public/v1",
      "https://api.test.adrate.io/",
    ]) {
      expect(parseTokenIndex({ ...validTokenIndex(), issuerOrigin })).toBeNull()
      expect(
        parseCredentialMetadata({
          ...validCredentialMetadata(),
          issuerOrigin,
        })
      ).toBeNull()
    }

    expect(
      parseDeviceState({
        ...validDeviceState(),
        issuerOrigin: "https://api.test.adrate.io",
      })
    ).toBeNull()
  })

  it("requires the exact ordered M0 scope and canonical Device URL pairing", () => {
    const swapped = [...validDeviceState().requestedScopes]
    ;[swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!]
    expect(
      parseDeviceState({ ...validDeviceState(), requestedScopes: swapped })
    ).toBeNull()
    expect(
      parseDeviceState({
        ...validDeviceState(),
        verificationUri: "https://evil.example/cli/authorize",
      })
    ).toBeNull()
    expect(
      parseDeviceState({
        ...validDeviceState(),
        verificationUriComplete:
          "https://app.adrate.io/cli/authorize?user_code=WXYZ-2345",
      })
    ).toBeNull()
  })

  it("enforces Device secret scrubbing and delivery verification invariants", () => {
    expect(
      parseDeviceState({
        ...validDeviceState(),
        localState: "token_received",
        deviceCode: null,
        userCode: null,
      })
    ).not.toBeNull()
    expect(
      parseDeviceState({
        ...validDeviceState(),
        localState: "token_received",
      })
    ).toBeNull()
    expect(
      parseDeviceState({
        ...validDeviceState(),
        localState: "polling",
        deviceCode: null,
        userCode: null,
      })
    ).toBeNull()
    expect(
      parseDeviceState({
        ...validDeviceState(),
        localState: "issued",
        deliveryVerificationAttemptedAt: "2026-07-31T08:01:00.000Z",
      })
    ).toBeNull()
    expect(
      parseDeviceState({
        ...validDeviceState(),
        localState: "delivery_unknown",
        deliveryVerificationAttemptedAt: "2026-07-31T08:01:00.000Z",
      })
    ).not.toBeNull()

    const terminalAttempt = validDevicePollAttempt({
      phase: "dispatch_intent",
      dispatchedAt: "2026-07-31T08:00:01.000Z",
    })
    const terminal = {
      ...validDeviceState(),
      localState: "terminal",
      deviceCode: null,
      userCode: null,
      terminalEvidence: {
        acknowledgedAt: "2026-07-31T08:00:02.000Z",
        attempt: terminalAttempt,
      },
    }
    expect(parseDeviceState(terminal)).not.toBeNull()
    expect(
      parseDeviceState({
        ...terminal,
        terminalEvidence: null,
      })
    ).toBeNull()
    expect(
      parseDeviceState({
        ...terminal,
        terminalEvidence: {
          ...terminal.terminalEvidence,
          acknowledgedAt: "2026-07-31T08:00:00.000Z",
        },
      })
    ).toBeNull()
    expect(
      parseDeviceState({
        ...validDeviceState(),
        terminalEvidence: terminal.terminalEvidence,
      })
    ).toBeNull()
  })

  it("rejects noncanonical timestamps, unsafe local text, and malformed ids", () => {
    expect(
      parseTokenIndex({
        ...validTokenIndex(),
        tokenReceivedAt: "2026-07-31T16:00:00+08:00",
      })
    ).toBeNull()
    const staging = validTokenIndex({
      state: "staging",
      storageCommit: {
        transactionId: "77777777-7777-4777-8777-777777777777",
        ownerPid: 12345,
        ownerProcessFingerprint: "test-process:started-at-1",
        leaseExpiresAt: "2026-07-31T08:00:45.000Z",
      },
    })
    expect(
      parseTokenIndex({
        ...staging,
        storageCommit: {
          ...staging.storageCommit!,
          leaseExpiresAt: staging.tokenReceivedAt,
        },
      })
    ).toBeNull()
    expect(
      parseCredentialMetadata({
        ...validCredentialMetadata(),
        teamName: "unsafe\nteam",
      })
    ).toBeNull()
    expect(
      parseTokenIndex({
        ...validTokenIndex(),
        credentialId: "11111111-1111-0111-8111-111111111111",
      })
    ).toBeNull()
  })

  it("accepts only the frozen logout outcome and reason combinations", () => {
    for (const reason of ["revoked", "already_inactive"] as const) {
      const journal = validLogoutDeliveryJournal({
        phase: "outcome_recorded",
        remoteOutcome: "confirmed_inactive",
        reason,
        recordedAt: "2026-07-31T08:00:01.000Z",
      })
      expect(parseLogoutDeliveryJournal(journal)).toEqual(journal)
    }

    const acknowledged = validLogoutDeliveryJournal({
      phase: "output_acknowledged",
      remoteOutcome: "confirmed_inactive",
      reason: "revoked",
      recordedAt: "2026-07-31T08:00:01.000Z",
    })
    expect(parseLogoutDeliveryJournal(acknowledged)).toEqual(acknowledged)

    for (const reason of [
      "owner_required",
      "transport_unknown",
      "unlocatable",
      "interrupted_cleanup",
    ] as const) {
      const journal = validLogoutDeliveryJournal({
        phase: "outcome_recorded",
        remoteOutcome: "unknown",
        reason,
        recordedAt: "2026-07-31T08:00:01.000Z",
      })
      expect(parseLogoutDeliveryJournal(journal)).toEqual(journal)
    }

    expect(
      parseLogoutDeliveryJournal({
        ...validLogoutDeliveryJournal(),
        phase: "unsupported_phase",
      })
    ).toBeNull()
    expect(
      parseLogoutDeliveryJournal({
        ...validLogoutDeliveryJournal(),
        phase: "output_acknowledged",
      })
    ).toBeNull()
    expect(
      parseLogoutDeliveryJournal({
        ...validLogoutDeliveryJournal(),
        phase: "outcome_recorded",
        remoteOutcome: "unsupported_outcome",
        recordedAt: "2026-07-31T08:00:01.000Z",
      })
    ).toBeNull()
    expect(
      parseLogoutDeliveryJournal({
        ...validLogoutDeliveryJournal(),
        reason: "unsupported_reason",
      })
    ).toBeNull()
  })

  it("binds logout dispatch and recorded phases to their exact evidence", () => {
    expect(
      parseLogoutDeliveryJournal({
        ...validLogoutDeliveryJournal(),
        remoteOutcome: "unknown",
      })
    ).toBeNull()
    expect(
      parseLogoutDeliveryJournal({
        ...validLogoutDeliveryJournal(),
        reason: "owner_required",
      })
    ).toBeNull()
    expect(
      parseLogoutDeliveryJournal({
        ...validLogoutDeliveryJournal(),
        recordedAt: "2026-07-31T08:00:01.000Z",
      })
    ).toBeNull()
    expect(
      parseLogoutDeliveryJournal({
        ...validLogoutDeliveryJournal(),
        phase: "outcome_recorded",
        remoteOutcome: null,
        recordedAt: "2026-07-31T08:00:01.000Z",
      })
    ).toBeNull()
    expect(
      parseLogoutDeliveryJournal({
        ...validLogoutDeliveryJournal(),
        phase: "outcome_recorded",
        remoteOutcome: "unknown",
        recordedAt: null,
      })
    ).toBeNull()
    expect(
      parseLogoutDeliveryJournal({
        ...validLogoutDeliveryJournal(),
        phase: "outcome_recorded",
        remoteOutcome: "confirmed_inactive",
        reason: "owner_required",
        recordedAt: "2026-07-31T08:00:01.000Z",
      })
    ).toBeNull()
    expect(
      parseLogoutDeliveryJournal({
        ...validLogoutDeliveryJournal(),
        phase: "outcome_recorded",
        remoteOutcome: "unknown",
        reason: "revoked",
        recordedAt: "2026-07-31T08:00:01.000Z",
      })
    ).toBeNull()
    expect(
      parseLogoutDeliveryJournal({
        ...validLogoutDeliveryJournal(),
        phase: "outcome_recorded",
        remoteOutcome: "unknown",
        recordedAt: "2026-07-31T07:59:59.000Z",
      })
    ).toBeNull()
    expect(
      parseLogoutDeliveryJournal({
        ...validLogoutDeliveryJournal(),
        phase: "outcome_recorded",
        remoteOutcome: "unknown",
        recordedAt: "2026-07-31T16:00:01+08:00",
      })
    ).toBeNull()
  })

  it("enforces logout issuer, credential generation, and resolution boundaries", () => {
    const withoutIssuer = validLogoutDeliveryJournal({
      expectedEnvironment: null,
      expectedIssuerOrigin: null,
    })
    expect(parseLogoutDeliveryJournal(withoutIssuer)).toEqual(withoutIssuer)

    const testEnvironment = validLogoutDeliveryJournal({
      expectedEnvironment: "test",
      expectedIssuerOrigin: "https://api.test.adrate.io",
      resolutionEnvironment: "test",
    })
    expect(parseLogoutDeliveryJournal(testEnvironment)).toEqual(testEnvironment)

    const withoutResolution = validLogoutDeliveryJournal({
      resolutionEnvironment: null,
    })
    expect(parseLogoutDeliveryJournal(withoutResolution)).toEqual(
      withoutResolution
    )

    for (const journal of [
      validLogoutDeliveryJournal({ expectedEnvironment: null }),
      validLogoutDeliveryJournal({ expectedIssuerOrigin: null }),
      validLogoutDeliveryJournal({
        expectedEnvironment: "test",
        expectedIssuerOrigin: "https://api.adrate.io",
      }),
      validLogoutDeliveryJournal({ expectedCredentialId: null }),
      validLogoutDeliveryJournal({ expectedTokenGeneration: null }),
      {
        ...validLogoutDeliveryJournal(),
        resolutionEnvironment: "staging",
      },
    ]) {
      expect(parseLogoutDeliveryJournal(journal)).toBeNull()
    }
  })

  it("requires a concrete safe logout request id", () => {
    const boundary = validLogoutDeliveryJournal({
      requestId: "r".repeat(128),
    })
    expect(parseLogoutDeliveryJournal(boundary)).toEqual(boundary)

    for (const requestId of [
      "",
      "contains space",
      "contains:colon",
      "contains\nnewline",
      "r".repeat(129),
      null,
      undefined,
      42,
    ]) {
      expect(
        parseLogoutDeliveryJournal({
          ...validLogoutDeliveryJournal(),
          requestId,
        })
      ).toBeNull()
    }
  })
})

describe("state store and cross-file issuer boundary", () => {
  it("round-trips and clears the logout delivery journal", async () => {
    fixture = await createTemporaryStateFixture()
    const state = new CliStateStore(fixture.fileSystem, fixture.paths)
    const journal = validLogoutDeliveryJournal()

    await expect(state.readLogoutDeliveryJournal()).resolves.toBeNull()
    await state.writeLogoutDeliveryJournal(journal)
    await expect(state.readLogoutDeliveryJournal()).resolves.toEqual(journal)
    await state.clearLogoutDeliveryJournal()
    await expect(state.readLogoutDeliveryJournal()).resolves.toBeNull()
  })

  it("fails loudly when the logout journal has a non-exact schema", async () => {
    fixture = await createTemporaryStateFixture()
    const state = new CliStateStore(fixture.fileSystem, fixture.paths)
    await fixture.fileSystem.atomicWrite(
      fixture.paths.logoutDeliveryJournal,
      `${JSON.stringify(withExtraKey(validLogoutDeliveryJournal()))}\n`
    )

    await expect(state.readLogoutDeliveryJournal()).rejects.toMatchObject({
      name: "CliFailure",
      exitCode: 2,
      envelope: {
        error: {
          details: { reason: "metadata_mismatch" },
        },
      },
    })
  })

  it("fails loudly when an on-disk state file has a non-exact schema", async () => {
    fixture = await createTemporaryStateFixture()
    const state = new CliStateStore(fixture.fileSystem, fixture.paths)
    await fixture.fileSystem.atomicWrite(
      fixture.paths.config,
      `${JSON.stringify(withExtraKey(validConfig()))}\n`
    )

    await expect(state.readConfig()).rejects.toMatchObject({
      name: "CliFailure",
      exitCode: 2,
      envelope: {
        error: {
          details: { reason: "metadata_mismatch" },
        },
      },
    })
  })

  it("treats individually valid production/test files as metadata mismatch", () => {
    const coordinator = new LocalCredentialCoordinator(
      null as never,
      null as never
    )
    const result = coordinator.inspectLocalSnapshot({
      config: validConfig(),
      index: validTokenIndex({
        issuerOrigin: "https://api.test.adrate.io",
      }),
      metadata: null,
      device: null,
      issueReservation: null,
      pollAttempt: null,
      cleanupReservation: null,
      fallbackExists: false,
    })

    expect(result).toEqual({
      state: "local_incomplete",
      reason: "metadata_mismatch",
    })
  })

  it("rejects credential metadata that disagrees with its token index", () => {
    const coordinator = new LocalCredentialCoordinator(
      null as never,
      null as never
    )
    const result = coordinator.inspectLocalSnapshot({
      config: validConfig(),
      index: validTokenIndex(),
      metadata: validCredentialMetadata({
        issuerOrigin: "https://api.test.adrate.io",
      }),
      device: null,
      issueReservation: null,
      pollAttempt: null,
      cleanupReservation: null,
      fallbackExists: false,
    })

    expect(result).toEqual({
      state: "local_incomplete",
      reason: "metadata_mismatch",
    })
  })
})
