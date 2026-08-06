import {
  environmentForMachineOrigin,
  issuerForEnvironment,
} from "../config/issuer.js"
import type { CliEnvironment } from "../constants.js"
import type { LocalCredentialCoordinator } from "./local-credentials.js"
import type {
  CliConfig,
  CredentialMetadata,
  DeviceAuthorizationState,
  DeviceIssueReservation,
  DevicePollAttempt,
  TokenIndex,
} from "../storage/schemas.js"
import type { JsonObject } from "../contracts/json.js"

interface Evidence<T> {
  value: T | null
  damaged: boolean
}

export interface AuthRemediationEvidence {
  index: Evidence<TokenIndex>
  device: Evidence<DeviceAuthorizationState>
  issueAttempt: Evidence<DeviceIssueReservation>
  pollAttempt: Evidence<DevicePollAttempt>
  metadata: Evidence<CredentialMetadata>
  config: Evidence<CliConfig>
  fallbackExists: boolean
}

export async function readAuthRemediationEvidence(
  local: LocalCredentialCoordinator
): Promise<AuthRemediationEvidence> {
  return local.state.withAuthLock(async () => {
    const [index, device, issueAttempt, pollAttempt, metadata, config] =
      await Promise.all([
        readEvidence(local.state.paths.tokenIndex, () =>
          local.state.readTokenIndex()
        ),
        readEvidence(local.state.paths.deviceCurrent, () =>
          local.state.readDeviceState()
        ),
        readEvidence(local.state.paths.deviceIssueReservation, () =>
          local.state.readDeviceIssueReservation()
        ),
        readEvidence(local.state.paths.devicePollAttempt, () =>
          local.state.readDevicePollAttempt()
        ),
        readEvidence(local.state.paths.credentials, () =>
          local.state.readCredentials()
        ),
        readEvidence(local.state.paths.config, () => local.state.readConfig()),
      ])
    return {
      index,
      device,
      issueAttempt,
      pollAttempt,
      metadata,
      config,
      fallbackExists: await local.state.fileSystem.exists(
        local.state.paths.fallbackToken
      ),
    }
  })

  async function readEvidence<T>(
    path: string,
    read: () => Promise<T | null>
  ): Promise<Evidence<T>> {
    if (!(await local.state.fileSystem.exists(path))) {
      return { value: null, damaged: false }
    }
    try {
      const value = await read()
      return value === null
        ? { value: null, damaged: true }
        : { value, damaged: false }
    } catch {
      return { value: null, damaged: true }
    }
  }
}

/**
 * remediation 不能从命令 flag 或 production 默认值猜环境。实际 credential
 * index 是最高优先级；同一层的 Device/attempt 证据冲突时返回 unknown。
 */
export function resolveRemediationEnvironment(
  evidence: AuthRemediationEvidence
): CliEnvironment | null {
  if (
    evidence.fallbackExists &&
    evidence.index.value?.storageKind !== "fallback_file"
  ) {
    return null
  }
  if (evidence.index.value) return evidence.index.value.environment
  if (evidence.index.damaged) return null

  const flowEntries = [
    evidence.device,
    evidence.issueAttempt,
    evidence.pollAttempt,
  ]
  if (flowEntries.some((entry) => entry.damaged)) return null
  const device = evidence.device.value
  const issue = evidence.issueAttempt.value
  const poll = evidence.pollAttempt.value
  // issue reservation 属于发码事务，Device/poll 属于已发码后的另一代事务。
  // 两类证据同时存在时没有可证明的 owner 绑定，必须 fail-closed。
  if (issue && (device || poll)) return null
  if (poll && !device) return null
  if (
    device &&
    poll &&
    poll.deviceGeneration !== device.generation
  ) {
    return null
  }
  const flow = device ?? issue
  if (flow) return flow.environment

  // 无 index 时的 fallback 无法证明 issuer，任何低优先级 metadata/config
  // 都不得越过该孤儿秘密文件猜测环境。
  if (evidence.fallbackExists) return null
  if (evidence.metadata.value) {
    return environmentForMachineOrigin(evidence.metadata.value.issuerOrigin)
  }
  if (evidence.metadata.damaged) return null

  if (evidence.config.value) return evidence.config.value.environment
  return null
}

export function remediationDetails(
  evidence: AuthRemediationEvidence
): JsonObject {
  const environment = resolveRemediationEnvironment(evidence)
  if (environment === null) {
    return {
      resolutionEnvironment: "unknown",
      suggestedAction: "confirm_environment",
      environmentConfirmationRequired: true,
    }
  }
  return {
    resolutionEnvironment: environment,
    suggestedAction: "open_account_security",
    resolutionUrl: new URL(
      "/settings/security",
      issuerForEnvironment(environment).browserOrigin
    ).toString(),
  }
}
