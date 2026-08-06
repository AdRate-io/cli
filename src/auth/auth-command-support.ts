import { hostname } from "node:os"
import { EXIT_CODE } from "../constants.js"
import { createLocalError } from "../contracts/envelope.js"
import { retryAfterWarning, usageFailure } from "../errors.js"
import type {
  PublicEnvelope,
  PublicErrorEnvelope,
} from "../contracts/envelope.js"
import type { CliOutcome } from "../errors.js"
import type { GlobalOptions } from "../parser.js"

export interface AuthLoginInput {
  global: GlobalOptions
  noWait: boolean
  resume: boolean
  device?: boolean
  deviceName?: string
}

export interface ValidatedAuthLoginInput {
  global: GlobalOptions
  noWait: boolean
  resume: boolean
  device: boolean
  deviceName: string | null
  deviceNameProvided: boolean
}

export function cleanDeviceName(value: string | undefined): string | null {
  const input = value ?? hostname()
  const normalized = [...input]
    .filter((character) => {
      const code = character.codePointAt(0)
      return code !== undefined && code > 0x1f && code !== 0x7f
    })
    .join("")
    .trim()
  if (normalized.length === 0) return null
  if (normalized.length > 128) {
    throw usageFailure("--device-name must be at most 128 characters.")
  }
  return normalized
}

/**
 * auth login 的唯一纯输入校验入口。parser 和 AuthService 共用，
 * 调用者必须在读取日志、本地状态、Keychain 或网络前执行。
 */
export function validateAuthLoginInput(
  input: AuthLoginInput
): ValidatedAuthLoginInput {
  const device = input.device ?? false
  if (input.noWait && input.resume) {
    throw usageFailure("--no-wait and --resume are mutually exclusive.")
  }
  if (device && input.noWait) {
    throw usageFailure("--device and --no-wait are mutually exclusive.")
  }
  if (device && input.resume) {
    throw usageFailure("--device and --resume are mutually exclusive.")
  }
  if (input.global.test && input.resume) {
    throw usageFailure("--test cannot be used with auth login --resume.")
  }
  if (input.resume && input.deviceName !== undefined) {
    throw usageFailure("--device-name cannot be used with --resume.")
  }
  if (input.global.noInput && !input.noWait && !input.resume && !device) {
    throw usageFailure(
      "auth login with --no-input requires --no-wait, --resume, or --device."
    )
  }
  return {
    global: input.global,
    noWait: input.noWait,
    resume: input.resume,
    device,
    deviceName: input.resume ? null : cleanDeviceName(input.deviceName),
    deviceNameProvided: input.deviceName !== undefined,
  }
}

export function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString()
}

export function oauthWaitOutcome(
  requestId: string,
  oauthError: "authorization_pending" | "slow_down",
  retryAfterSeconds: number
): CliOutcome {
  const envelope = createLocalError(
    requestId,
    "RATE_LIMITED",
    oauthError === "slow_down"
      ? "The authorization server requested slower polling."
      : "Authorization is still pending.",
    true,
    {
      oauthError,
      retryAfterSeconds,
      suggestedAction: "retry_after",
    }
  )
  envelope.meta.retryAfterSeconds = retryAfterSeconds
  return {
    exitCode: EXIT_CODE.retryable,
    envelope,
    warnings: [retryAfterWarning(retryAfterSeconds)],
    retryAfterSeconds,
  }
}

export function withAuthStatusUnverified(
  envelope: PublicErrorEnvelope
): PublicErrorEnvelope {
  return {
    ...envelope,
    error: {
      ...envelope.error,
      details: {
        ...envelope.error.details,
        authStatus: "unverified",
      },
    },
  }
}

export function withPendingMeta(
  envelope: PublicEnvelope,
  pendingCommands: number
): PublicEnvelope {
  return {
    ...envelope,
    meta: {
      ...envelope.meta,
      pendingCommandsRetained: pendingCommands,
      pendingCommandRecoveryRisk:
        pendingCommands > 0
          ? "Changing credentials prevents recovery of Commands created by the previous credential."
          : null,
    },
  } as PublicEnvelope
}
