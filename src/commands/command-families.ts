import { isPlainObject } from "../contracts/json.js"
import { isValidResourceId } from "../contracts/resource-input.js"
import type { JsonObject } from "../contracts/json.js"
import type { PublicCommandDto } from "../contracts/command.js"

/**
 * CLI 侧 Command 家族注册表——与服务端 public-command-families.ts 对称。
 *
 * 每个 Command 型 capability 注册一个家族描述，声明：
 * - target DTO 解码/校验
 * - intent 构造与规范化序列（用于 journal 的 intentHash + resume 同意图判定）
 * - 成功证明（isNoOp / isTargetReached 的 CLI 等价物）
 * - Dispatcher 参数构造（POST path + body）
 */

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

export const PENDING_COMMAND_CAPABILITIES = Object.freeze([
  "ads.campaign.status.write",
  "ads.campaign.budget.write",
  "gmvmax.campaign.status.write",
  "gmvmax.campaign.budget.write",
  "gmvmax.campaign.roas.write",
] as const)

export type PendingCommandCapabilityId =
  (typeof PENDING_COMMAND_CAPABILITIES)[number]

/**
 * 泛化 intent：capabilityId + advId + campaignId + authId 是所有 Command 共有的，
 * familyPayload 存储家族特有字段（status 存 desiredStatus，budget 存 mode+value）。
 */
export interface PendingCommandIntent {
  capabilityId: PendingCommandCapabilityId
  advId: string
  campaignId: string
  authId: number | null
  familyPayload: Record<string, unknown>
}

/**
 * 家族描述符：每个 Command 型 capability 注册一个。
 */
export interface CliCommandFamilyDescriptor {
  readonly capabilityId: PendingCommandCapabilityId
  readonly requiresAuthId: boolean

  /**
   * 从服务端 Command DTO 的 target 解码家族特有字段。
   * 返回 null = 解码失败（fail-closed）。
   */
  decodeTarget: (raw: Record<string, unknown>) => Record<string, unknown> | null

  /**
   * 成功证明：verified_no_op 判定（CLI 等价于服务端 isNoOpConsistent）。
   * command.beforeStatus 是否等于目标。
   */
  isNoOp: (command: PublicCommandDto) => boolean

  /**
   * 成功证明：observed_target_state 判定（CLI 等价于服务端 isTargetReachedConsistent）。
   * command.afterStatus 是否等于目标。
   */
  isTargetReached: (command: PublicCommandDto) => boolean

  /**
   * 从 familyPayload 提取参与 intent 规范化的字段对（顺序稳定）。
   * canonicalPendingIntent 按此序列化后 hash，用于 resume 同意图判定。
   */
  intentCanonicalFields: (
    payload: Record<string, unknown>
  ) => ReadonlyArray<[string, unknown]>

  /**
   * 服务端 Command DTO target 与本地 journal intent 的身份匹配。
   * budget 家族在 pending/locked 两态都保留原始 value，locked 态额外携带
   * targetBudget，因此恢复时始终可以精确比对原始意图。
   *
   * advertiserId + campaignId 在调用方已验证，此方法只比对家族特有字段。
   */
  matchesIntentTarget: (
    intentPayload: Record<string, unknown>,
    serverTarget: Record<string, unknown>
  ) => boolean

  /**
   * Dispatcher POST path 构造。
   */
  postPath: (intent: PendingCommandIntent) => string

  /**
   * Dispatcher POST body 构造。
   */
  postBody: (intent: PendingCommandIntent) => JsonObject
}

// ---------------------------------------------------------------------------
// Status 家族：ads.campaign.status.write
// ---------------------------------------------------------------------------

function decodeStatusTarget(
  raw: Record<string, unknown>
): Record<string, unknown> | null {
  if (raw.desiredStatus !== "ENABLE" && raw.desiredStatus !== "DISABLE") {
    return null
  }
  return { desiredStatus: raw.desiredStatus }
}

const STATUS_FAMILY: CliCommandFamilyDescriptor = {
  capabilityId: "ads.campaign.status.write",
  requiresAuthId: false,

  decodeTarget: decodeStatusTarget,

  isNoOp(command) {
    if (command.status !== "succeeded" || !command.isFinal) return false
    const target = command.target
    return (
      command.verificationBasis === "verified_no_op" &&
      command.beforeStatus === target.desiredStatus
    )
  },

  isTargetReached(command) {
    if (command.status !== "succeeded" || !command.isFinal) return false
    const target = command.target
    return (
      command.verificationBasis === "observed_target_state" &&
      command.afterStatus === target.desiredStatus
    )
  },

  intentCanonicalFields(payload) {
    return [["desiredStatus", payload.desiredStatus]]
  },

  matchesIntentTarget(intentPayload, serverTarget) {
    return serverTarget.desiredStatus === intentPayload.desiredStatus
  },

  postPath(intent) {
    return `/public/v1/ads/advertisers/${intent.advId}/campaigns/${intent.campaignId}/status`
  },

  postBody(intent) {
    return {
      desiredStatus: intent.familyPayload.desiredStatus as string,
      ...(intent.authId === null ? {} : { authId: intent.authId }),
    }
  },
}

// ---------------------------------------------------------------------------
// Budget 家族：ads.campaign.budget.write
// ---------------------------------------------------------------------------

export const BUDGET_MODES = new Set([
  "set",
  "increase_amount",
  "decrease_amount",
  "increase_percent",
  "decrease_percent",
])

function decodeBudgetTarget(
  raw: Record<string, unknown>
): Record<string, unknown> | null {
  const mode = raw.mode
  if (typeof mode !== "string" || !BUDGET_MODES.has(mode)) return null
  if (
    typeof raw.value === "number" &&
    Number.isFinite(raw.value) &&
    raw.value > 0
  ) {
    if (raw.targetBudget === undefined) {
      return { mode, value: raw.value }
    }
    if (
      typeof raw.targetBudget === "number" &&
      Number.isFinite(raw.targetBudget) &&
      raw.targetBudget > 0
    ) {
      return { mode, value: raw.value, targetBudget: raw.targetBudget }
    }
  }
  return null
}

const BUDGET_FAMILY: CliCommandFamilyDescriptor = {
  capabilityId: "ads.campaign.budget.write",
  requiresAuthId: false,

  decodeTarget: decodeBudgetTarget,

  isNoOp(command) {
    if (command.status !== "succeeded" || !command.isFinal) return false
    const target = command.target
    if (
      typeof target.targetBudget !== "number" ||
      command.beforeStatus === null
    )
      return false
    return (
      command.verificationBasis === "verified_no_op" &&
      Number(command.beforeStatus) === target.targetBudget
    )
  },

  isTargetReached(command) {
    if (command.status !== "succeeded" || !command.isFinal) return false
    const target = command.target
    if (typeof target.targetBudget !== "number" || command.afterStatus === null)
      return false
    return (
      command.verificationBasis === "observed_target_state" &&
      Number(command.afterStatus) === target.targetBudget
    )
  },

  intentCanonicalFields(payload) {
    return [
      ["mode", payload.mode],
      ...(typeof payload.value === "number"
        ? [["value", payload.value] as [string, unknown]]
        : []),
    ]
  },

  matchesIntentTarget(intentPayload, serverTarget) {
    return (
      serverTarget.mode === intentPayload.mode &&
      serverTarget.value === intentPayload.value
    )
  },

  postPath(intent) {
    return `/public/v1/ads/advertisers/${intent.advId}/campaigns/${intent.campaignId}/budget`
  },

  postBody(intent) {
    return {
      mode: intent.familyPayload.mode as string,
      value: intent.familyPayload.value as number,
      ...(intent.authId === null ? {} : { authId: intent.authId }),
    }
  },
}

const GMV_MAX_STATUS_FAMILY: CliCommandFamilyDescriptor = {
  capabilityId: "gmvmax.campaign.status.write",
  requiresAuthId: true,

  decodeTarget: decodeStatusTarget,

  isNoOp(command) {
    return (
      command.status === "succeeded" &&
      command.isFinal &&
      command.verificationBasis === "verified_no_op" &&
      command.beforeStatus === command.target.desiredStatus
    )
  },

  isTargetReached(command) {
    return (
      command.status === "succeeded" &&
      command.isFinal &&
      command.verificationBasis === "observed_target_state" &&
      command.afterStatus === command.target.desiredStatus
    )
  },

  intentCanonicalFields(payload) {
    return [["desiredStatus", payload.desiredStatus]]
  },

  matchesIntentTarget(intentPayload, serverTarget) {
    return serverTarget.desiredStatus === intentPayload.desiredStatus
  },

  postPath(intent) {
    return `/public/v1/gmvmax/advertisers/${intent.advId}/campaigns/${intent.campaignId}/status`
  },

  postBody(intent) {
    return {
      status: intent.familyPayload.desiredStatus as string,
      authId: intent.authId as number,
    }
  },
}

function createGmvMaxNumericFamily(
  capabilityId: "gmvmax.campaign.budget.write" | "gmvmax.campaign.roas.write",
  operation: "budget" | "roas",
  targetField: "targetBudget" | "targetRoas"
): CliCommandFamilyDescriptor {
  return {
    capabilityId,
    requiresAuthId: true,

    decodeTarget(raw) {
      const mode = raw.mode
      if (typeof mode !== "string" || !BUDGET_MODES.has(mode)) return null
      if (
        typeof raw.value !== "number" ||
        !Number.isFinite(raw.value) ||
        raw.value <= 0
      ) {
        return null
      }
      const target = raw[targetField]
      if (target === undefined) return { mode, value: raw.value }
      if (
        typeof target !== "number" ||
        !Number.isFinite(target) ||
        target <= 0
      ) {
        return null
      }
      return { mode, value: raw.value, [targetField]: target }
    },

    isNoOp(command) {
      const target = command.target[targetField]
      return (
        command.status === "succeeded" &&
        command.isFinal &&
        command.verificationBasis === "verified_no_op" &&
        typeof target === "number" &&
        command.beforeStatus !== null &&
        Number(command.beforeStatus) === target
      )
    },

    isTargetReached(command) {
      const target = command.target[targetField]
      return (
        command.status === "succeeded" &&
        command.isFinal &&
        command.verificationBasis === "observed_target_state" &&
        typeof target === "number" &&
        command.afterStatus !== null &&
        Number(command.afterStatus) === target
      )
    },

    intentCanonicalFields(payload) {
      return [
        ["mode", payload.mode],
        ["value", payload.value],
      ]
    },

    matchesIntentTarget(intentPayload, serverTarget) {
      return (
        serverTarget.mode === intentPayload.mode &&
        serverTarget.value === intentPayload.value
      )
    },

    postPath(intent) {
      return `/public/v1/gmvmax/advertisers/${intent.advId}/campaigns/${intent.campaignId}/${operation}`
    },

    postBody(intent) {
      return {
        mode: intent.familyPayload.mode as string,
        value: intent.familyPayload.value as number,
        authId: intent.authId as number,
      }
    },
  }
}

const GMV_MAX_BUDGET_FAMILY = createGmvMaxNumericFamily(
  "gmvmax.campaign.budget.write",
  "budget",
  "targetBudget"
)
const GMV_MAX_ROAS_FAMILY = createGmvMaxNumericFamily(
  "gmvmax.campaign.roas.write",
  "roas",
  "targetRoas"
)

// ---------------------------------------------------------------------------
// 家族注册表
// ---------------------------------------------------------------------------

const COMMAND_FAMILY_REGISTRY = new Map<string, CliCommandFamilyDescriptor>([
  [STATUS_FAMILY.capabilityId, STATUS_FAMILY],
  [BUDGET_FAMILY.capabilityId, BUDGET_FAMILY],
  [GMV_MAX_STATUS_FAMILY.capabilityId, GMV_MAX_STATUS_FAMILY],
  [GMV_MAX_BUDGET_FAMILY.capabilityId, GMV_MAX_BUDGET_FAMILY],
  [GMV_MAX_ROAS_FAMILY.capabilityId, GMV_MAX_ROAS_FAMILY],
])

export function getCliCommandFamily(
  capabilityId: string
): CliCommandFamilyDescriptor | null {
  return COMMAND_FAMILY_REGISTRY.get(capabilityId) ?? null
}

export function isPendingCommandCapability(
  capabilityId: string
): capabilityId is PendingCommandCapabilityId {
  return COMMAND_FAMILY_REGISTRY.has(capabilityId)
}

// ---------------------------------------------------------------------------
// 服务端 Command DTO → CLI target 解码（泛化版 decodePublicCommandDto 的核心）
// ---------------------------------------------------------------------------

/**
 * 从服务端 target 解码可信字段子集。两级校验：
 * 1. 共有字段（advertiserId + campaignId）
 * 2. 按 capabilityId 分派给家族 decodeTarget
 * 返回 freeze 后的 { advertiserId, campaignId, ...familyFields }。
 */
export function decodeCommandTarget(
  capabilityId: string,
  rawTarget: unknown
): Record<string, unknown> | null {
  if (!isPlainObject(rawTarget)) return null
  const target = rawTarget
  if (
    !isValidResourceId(target.advertiserId, "advId") ||
    !isValidResourceId(target.campaignId, "campaignId")
  ) {
    return null
  }
  const family = getCliCommandFamily(capabilityId)
  if (!family) return null
  const familyFields = family.decodeTarget(target)
  if (!familyFields) return null
  return Object.freeze({
    advertiserId: target.advertiserId,
    campaignId: target.campaignId,
    ...familyFields,
  })
}
