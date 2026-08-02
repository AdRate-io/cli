import {
  PRODUCTION_BROWSER_ORIGIN,
  PRODUCTION_MACHINE_ORIGIN,
  TEST_BROWSER_ORIGIN,
  TEST_MACHINE_ORIGIN,
} from "../constants.js"
import { usageFailure } from "../errors.js"
import type { CliEnvironment } from "../constants.js"

export interface IssuerPair {
  environment: CliEnvironment
  machineOrigin: string
  browserOrigin: string
}

export const ISSUERS: Readonly<Record<CliEnvironment, IssuerPair>> =
  Object.freeze({
    production: Object.freeze({
      environment: "production",
      machineOrigin: PRODUCTION_MACHINE_ORIGIN,
      browserOrigin: PRODUCTION_BROWSER_ORIGIN,
    }),
    test: Object.freeze({
      environment: "test",
      machineOrigin: TEST_MACHINE_ORIGIN,
      browserOrigin: TEST_BROWSER_ORIGIN,
    }),
  })

export function issuerForEnvironment(environment: CliEnvironment): IssuerPair {
  return ISSUERS[environment]
}

export function environmentForMachineOrigin(
  issuerOrigin: unknown
): CliEnvironment | null {
  if (issuerOrigin === PRODUCTION_MACHINE_ORIGIN) return "production"
  if (issuerOrigin === TEST_MACHINE_ORIGIN) return "test"
  return null
}

export function assertIssuerPair(
  environment: unknown,
  issuerOrigin: unknown
): asserts environment is CliEnvironment {
  if (
    (environment !== "production" && environment !== "test") ||
    issuerForEnvironment(environment).machineOrigin !== issuerOrigin
  ) {
    throw usageFailure(
      "Local issuer configuration is invalid. Run auth logout before starting a new authorization.",
      { reason: "metadata_mismatch" }
    )
  }
}

export function validateBrowserUrl(
  value: unknown,
  issuerOrigin: string
): string {
  const environment = environmentForMachineOrigin(issuerOrigin)
  if (!environment || typeof value !== "string") {
    throw usageFailure("The server returned an unsafe browser URL.")
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw usageFailure("The server returned an unsafe browser URL.")
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.origin !== issuerForEnvironment(environment).browserOrigin
  ) {
    throw usageFailure("The server returned an unsafe browser URL.")
  }
  return parsed.toString()
}

export function validateOptionalResolutionUrl(
  value: unknown,
  issuerOrigin: string
): string | null {
  if (value === null || value === undefined) return null
  try {
    return validateBrowserUrl(value, issuerOrigin)
  } catch {
    return null
  }
}
