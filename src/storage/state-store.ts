import { randomUUID } from "node:crypto"
import { usageFailure } from "../errors.js"
import { issuerForEnvironment } from "../config/issuer.js"
import {
  parseConfig,
  parseCredentialMetadata,
  parseDeviceIssueReservation,
  parseDevicePollAttempt,
  parseDeviceState,
  parseTokenIndex,
} from "./schemas.js"
import type { SecureFileSystem } from "./secure-files.js"
import type { CliEnvironment } from "../constants.js"
import type {
  CliConfig,
  CredentialMetadata,
  DeviceAuthorizationState,
  DeviceIssueReservation,
  DevicePollAttempt,
  TokenIndex,
} from "./schemas.js"
import type { CliPaths } from "./paths.js"

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw usageFailure(`${label} is not valid JSON.`, {
      reason: "metadata_mismatch",
    })
  }
}

export class CliStateStore {
  constructor(
    readonly fileSystem: SecureFileSystem,
    readonly paths: CliPaths
  ) {}

  withAuthLock<T>(action: () => Promise<T>): Promise<T> {
    return this.fileSystem.withLock(this.paths.authLock, action)
  }

  async readConfig(): Promise<CliConfig | null> {
    const text = await this.fileSystem.readSecureFile(this.paths.config)
    if (text === null) return null
    const parsed = parseConfig(parseJson(text, "config.json"))
    if (!parsed) {
      throw usageFailure("config.json has an unsupported or unsafe format.", {
        reason: "metadata_mismatch",
      })
    }
    return parsed
  }

  async ensureConfig(environment: CliEnvironment): Promise<CliConfig> {
    const existing = await this.readConfig()
    const issuerOrigin = issuerForEnvironment(environment).machineOrigin
    if (existing?.environment === environment) return existing
    const config: CliConfig = {
      configFormatVersion: 1,
      issuerOrigin,
      clientInstanceId: existing?.clientInstanceId ?? randomUUID(),
      environment,
    }
    await this.writeJson(this.paths.config, config)
    return config
  }

  async readTokenIndex(): Promise<TokenIndex | null> {
    const text = await this.fileSystem.readSecureFile(this.paths.tokenIndex)
    if (text === null) return null
    const parsed = parseTokenIndex(parseJson(text, "token-index.json"))
    if (!parsed) {
      throw usageFailure(
        "token-index.json has an unsupported or unsafe format.",
        { reason: "metadata_mismatch" }
      )
    }
    return parsed
  }

  writeTokenIndex(value: TokenIndex): Promise<void> {
    return this.writeJson(this.paths.tokenIndex, value)
  }

  async readCredentials(): Promise<CredentialMetadata | null> {
    const text = await this.fileSystem.readSecureFile(this.paths.credentials)
    if (text === null) return null
    const parsed = parseCredentialMetadata(parseJson(text, "credentials.json"))
    if (!parsed) {
      throw usageFailure(
        "credentials.json has an unsupported or unsafe format.",
        { reason: "metadata_mismatch" }
      )
    }
    return parsed
  }

  writeCredentials(value: CredentialMetadata): Promise<void> {
    return this.writeJson(this.paths.credentials, value)
  }

  async readDeviceState(): Promise<DeviceAuthorizationState | null> {
    const text = await this.fileSystem.readSecureFile(this.paths.deviceCurrent)
    if (text === null) return null
    const parsed = parseDeviceState(
      parseJson(text, "device-authorizations/current.json")
    )
    if (!parsed) {
      throw usageFailure(
        "The local Device Authorization state is unsafe or unsupported.",
        { reason: "metadata_mismatch" }
      )
    }
    return parsed
  }

  writeDeviceState(value: DeviceAuthorizationState): Promise<void> {
    return this.writeJson(this.paths.deviceCurrent, value)
  }

  async clearDeviceState(): Promise<void> {
    await this.fileSystem.removeSecureFile(this.paths.deviceCurrent)
  }

  async readDeviceIssueReservation(): Promise<DeviceIssueReservation | null> {
    const text = await this.fileSystem.readSecureFile(
      this.paths.deviceIssueReservation
    )
    if (text === null) return null
    const parsed = parseDeviceIssueReservation(
      parseJson(text, "device-authorizations/issue-reservation.json")
    )
    if (!parsed) {
      throw usageFailure(
        "The local Device issue reservation is unsafe or unsupported.",
        { reason: "metadata_mismatch" }
      )
    }
    return parsed
  }

  writeDeviceIssueReservation(value: DeviceIssueReservation): Promise<void> {
    return this.writeJson(this.paths.deviceIssueReservation, value)
  }

  async clearDeviceIssueReservation(): Promise<void> {
    await this.fileSystem.removeSecureFile(this.paths.deviceIssueReservation)
  }

  async readDevicePollAttempt(): Promise<DevicePollAttempt | null> {
    const text = await this.fileSystem.readSecureFile(
      this.paths.devicePollAttempt
    )
    if (text === null) return null
    const parsed = parseDevicePollAttempt(
      parseJson(text, "device-authorizations/poll-attempt.json")
    )
    if (!parsed) {
      throw usageFailure(
        "The local Device poll attempt is unsafe or unsupported.",
        { reason: "metadata_mismatch" }
      )
    }
    return parsed
  }

  writeDevicePollAttempt(value: DevicePollAttempt): Promise<void> {
    return this.writeJson(this.paths.devicePollAttempt, value)
  }

  async clearDevicePollAttempt(): Promise<void> {
    await this.fileSystem.removeSecureFile(this.paths.devicePollAttempt)
  }

  private writeJson(path: string, value: object): Promise<void> {
    return this.fileSystem.atomicWrite(
      path,
      `${JSON.stringify(value, null, 2)}\n`
    )
  }
}
