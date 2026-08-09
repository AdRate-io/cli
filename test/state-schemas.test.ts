import { afterEach, describe, expect, it } from "vitest"
import { LocalCredentialCoordinator } from "../src/auth/local-credentials.js"
import {
  parseConfig,
  parseCredentialMetadata,
  parseDeviceIssueReservation,
  parseDevicePollAttempt,
  parseDeviceState,
  parseTokenIndex,
} from "../src/storage/schemas.js"
import { CliStateStore } from "../src/storage/state-store.js"
import {
  createTemporaryStateFixture,
  validConfig,
  validCredentialMetadata,
  validDeviceIssueReservation,
  validDevicePollAttempt,
  validDeviceState,
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

    expect(parseConfig(config)).toEqual(config)
    expect(parseTokenIndex(index)).toEqual(index)
    expect(parseCredentialMetadata(metadata)).toEqual(metadata)
    expect(parseDeviceState(device)).toEqual(device)
    expect(parseDeviceIssueReservation(reservation)).toEqual(reservation)
    expect(parseDevicePollAttempt(pollAttempt)).toEqual(pollAttempt)
  })

  it("tolerates unknown fields for every local state schema", () => {
    expect(parseConfig(withExtraKey(validConfig()))).not.toBeNull()
    expect(parseTokenIndex(withExtraKey(validTokenIndex()))).not.toBeNull()
    expect(
      parseCredentialMetadata(withExtraKey(validCredentialMetadata()))
    ).not.toBeNull()
    expect(parseDeviceState(withExtraKey(validDeviceState()))).not.toBeNull()
    expect(
      parseDeviceIssueReservation(withExtraKey(validDeviceIssueReservation()))
    ).not.toBeNull()
    expect(
      parseDevicePollAttempt(withExtraKey(validDevicePollAttempt()))
    ).not.toBeNull()
  })

  it("keeps legacy credential metadata readable without absoluteExpiresAt", () => {
    const legacy = {
      ...validCredentialMetadata(),
    } as Record<string, unknown>
    delete legacy.absoluteExpiresAt
    expect(parseCredentialMetadata(legacy)).toEqual(legacy)
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

    const device = { ...validDeviceState() } as Record<string, unknown>
    delete device.nextPollAt
    expect(parseDeviceState(device)).toBeNull()

    const issueReservation = {
      ...validDeviceIssueReservation(),
    } as Record<string, unknown>
    delete issueReservation.generation
    expect(parseDeviceIssueReservation(issueReservation)).toBeNull()

    const pollAttempt = {
      ...validDevicePollAttempt(),
    } as Record<string, unknown>
    delete pollAttempt.deviceGeneration
    expect(parseDevicePollAttempt(pollAttempt)).toBeNull()
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
  })

  it("keeps only Device generation and optional backend selection in poll staging", () => {
    expect(
      parseDevicePollAttempt(validDevicePollAttempt({ storageKind: null }))
    ).not.toBeNull()
    expect(
      parseDevicePollAttempt(
        validDevicePollAttempt({
          storageKind: "unknown" as "keychain",
        })
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
    }
    expect(
      parseDeviceState({
        ...validDeviceState(),
        issuerOrigin: "https://api.test.adrate.io",
      })
    ).toBeNull()
  })

  it("requires the exact ordered CLI scope and canonical Device URL pairing", () => {
    const swapped = [...validDeviceState().requestedScopes]
    ;[swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!]
    expect(
      parseDeviceState({ ...validDeviceState(), requestedScopes: swapped })
    ).toBeNull()
    expect(
      parseDeviceState({
        ...validDeviceState(),
        verificationUriComplete:
          "https://app.adrate.io/cli/authorize?user_code=WXYZ-2345",
      })
    ).toBeNull()
  })

  it("enforces Device secret scrubbing on token_received", () => {
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
  })

  it("rejects noncanonical timestamps, unsafe local text, and malformed ids", () => {
    expect(
      parseTokenIndex({
        ...validTokenIndex(),
        tokenReceivedAt: "2026-07-31T16:00:00+08:00",
      })
    ).toBeNull()
    expect(
      parseCredentialMetadata({
        ...validCredentialMetadata(),
        teamName: "unsafe\nteam",
      })
    ).toBeNull()
    expect(
      parseCredentialMetadata({
        ...validCredentialMetadata(),
        absoluteExpiresAt: "2026-08-30T16:00:00+08:00",
      })
    ).toBeNull()
  })
})

describe("state store and cross-file issuer boundary", () => {
  it("tolerates extra keys in config on disk", async () => {
    fixture = await createTemporaryStateFixture()
    const state = new CliStateStore(fixture.fileSystem, fixture.paths)
    await fixture.fileSystem.atomicWrite(
      fixture.paths.config,
      `${JSON.stringify(withExtraKey(validConfig()))}\n`
    )

    const config = await state.readConfig()
    expect(config).not.toBeNull()
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
      fallbackExists: false,
    })

    expect(result).toEqual({
      state: "local_incomplete",
      reason: "metadata_mismatch",
    })
  })
})
