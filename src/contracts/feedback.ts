import { LOWERCASE_UUID_PATTERN } from "../constants.js"
import { hasKeys, isCanonicalUtcIso } from "./json.js"
import type { PublicSuccessEnvelope } from "./envelope.js"

export interface FeedbackReceipt {
  feedbackId: string
  receivedAt: string
  duplicate: boolean
  redactionApplied: boolean
}

/**
 * 只投影 CLI 报告成功所需的最小回执。服务端可继续增加展示字段，
 * 但核心回执缺失或类型不可信时绝不报告成功。
 */
export function decodeFeedbackReceipt(
  envelope: PublicSuccessEnvelope
): FeedbackReceipt | null {
  const data = envelope.data
  if (
    !hasKeys(data, [
      "feedbackId",
      "receivedAt",
      "duplicate",
      "redactionApplied",
    ]) ||
    typeof data.feedbackId !== "string" ||
    !LOWERCASE_UUID_PATTERN.test(data.feedbackId) ||
    !isCanonicalUtcIso(data.receivedAt) ||
    typeof data.duplicate !== "boolean" ||
    typeof data.redactionApplied !== "boolean"
  ) {
    return null
  }
  return {
    feedbackId: data.feedbackId,
    receivedAt: data.receivedAt,
    duplicate: data.duplicate,
    redactionApplied: data.redactionApplied,
  }
}
