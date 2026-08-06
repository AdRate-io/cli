import { describe, expect, it } from "vitest"
import {
  remediationDetails,
  resolveRemediationEnvironment,
} from "../src/auth/auth-remediation.js"
import {
  validConfig,
  validCredentialMetadata,
  validDeviceIssueReservation,
  validDevicePollAttempt,
  validDeviceState,
  validTokenIndex,
} from "./helpers.js"
import type { AuthRemediationEvidence } from "../src/auth/auth-remediation.js"

function absent<T>(): { value: T | null; damaged: boolean } {
  return { value: null, damaged: false }
}

function evidence(
  overrides: Partial<AuthRemediationEvidence> = {}
): AuthRemediationEvidence {
  return {
    index: absent(),
    device: absent(),
    issueAttempt: absent(),
    pollAttempt: absent(),
    metadata: absent(),
    config: absent(),
    fallbackExists: false,
    ...overrides,
  }
}

describe("auth remediation environment", () => {
  it("prioritizes the actual credential index over an opposite config", () => {
    expect(
      resolveRemediationEnvironment(
        evidence({
          index: {
            value: validTokenIndex({
              environment: "test",
              issuerOrigin: "https://api.test.adrate.io",
            }),
            damaged: false,
          },
          config: { value: validConfig(), damaged: false },
        })
      )
    ).toBe("test")

    expect(
      resolveRemediationEnvironment(
        evidence({
          index: { value: validTokenIndex(), damaged: false },
          config: {
            value: validConfig({
              environment: "test",
              issuerOrigin: "https://api.test.adrate.io",
            }),
            damaged: false,
          },
        })
      )
    ).toBe("production")
  })

  it("binds an existing fallback file only to a matching fallback index", () => {
    expect(
      resolveRemediationEnvironment(
        evidence({
          fallbackExists: true,
          index: {
            value: validTokenIndex({ storageKind: "fallback_file" }),
            damaged: false,
          },
        })
      )
    ).toBe("production")
  })

  it("derives a test remediation from metadata without config", () => {
    expect(
      resolveRemediationEnvironment(
        evidence({
          metadata: {
            value: validCredentialMetadata({
              issuerOrigin: "https://api.test.adrate.io",
            }),
            damaged: false,
          },
        })
      )
    ).toBe("test")
  })

  it("accepts only a fully bound Device and poll generation", () => {
    expect(
      resolveRemediationEnvironment(
        evidence({
          device: { value: validDeviceState(), damaged: false },
          pollAttempt: { value: validDevicePollAttempt(), damaged: false },
        })
      )
    ).toBe("production")
  })

  it("returns unknown for damaged, conflicting, orphaned or absent evidence", () => {
    const cases = [
      evidence({
        index: { value: null, damaged: true },
        config: { value: validConfig(), damaged: false },
      }),
      evidence({
        fallbackExists: true,
        config: { value: validConfig(), damaged: false },
      }),
      evidence({
        fallbackExists: true,
        metadata: { value: validCredentialMetadata(), damaged: false },
      }),
      evidence({
        fallbackExists: true,
        index: { value: validTokenIndex(), damaged: false },
      }),
      evidence({
        device: { value: validDeviceState(), damaged: false },
        issueAttempt: {
          value: validDeviceIssueReservation(),
          damaged: false,
        },
      }),
      evidence({
        device: { value: validDeviceState(), damaged: false },
        pollAttempt: {
          value: validDevicePollAttempt({
            deviceGeneration: "77777777-7777-4777-8777-777777777777",
          }),
          damaged: false,
        },
      }),
      evidence({
        pollAttempt: { value: validDevicePollAttempt(), damaged: false },
      }),
      evidence(),
    ]
    for (const value of cases) {
      expect(resolveRemediationEnvironment(value)).toBeNull()
      expect(remediationDetails(value)).toEqual({
        resolutionEnvironment: "unknown",
        suggestedAction: "confirm_environment",
        environmentConfirmationRequired: true,
      })
    }
  })

  it("only emits a canonical security URL when environment is resolved", () => {
    expect(
      remediationDetails(
        evidence({
          device: {
            value: validDeviceState({
              environment: "test",
              issuerOrigin: "https://api.test.adrate.io",
              verificationUri: "https://test.adrate.io/cli/authorize",
              verificationUriComplete:
                "https://test.adrate.io/cli/authorize?user_code=ABCD-EFGH",
            }),
            damaged: false,
          },
        })
      )
    ).toEqual({
      resolutionEnvironment: "test",
      suggestedAction: "open_account_security",
      resolutionUrl: "https://test.adrate.io/settings/security",
    })
  })
})
