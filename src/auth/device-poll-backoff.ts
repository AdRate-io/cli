export const OAUTH_RETRY_AFTER_MAX_SECONDS = 86_400

export interface DevicePollSchedule {
  /** RFC 8628 协议轮询间隔，只能由 pending/slow_down 规则改变。 */
  protocolIntervalSeconds: number
  /** 本次可再次轮询前的实际等待，可大于协议间隔。 */
  nextPollDelaySeconds: number
  nextPollAt: string
}

/**
 * 按 RFC 8628 slow_down 合同计算新的协议轮询间隔。
 *
 * 调用方必须先把 Retry-After 解析为 1..30 的整数；这里只
 * 接受已验证事实，使响应归档与崩溃恢复共用同一算法。
 */
export function resolveSlowDownProtocolInterval(input: {
  previousProtocolIntervalSeconds: number
  retryAfterSeconds: number
}): number {
  if (
    !Number.isSafeInteger(input.previousProtocolIntervalSeconds) ||
    input.previousProtocolIntervalSeconds < 1 ||
    input.previousProtocolIntervalSeconds > 30 ||
    !Number.isSafeInteger(input.retryAfterSeconds) ||
    input.retryAfterSeconds < 1 ||
    input.retryAfterSeconds > 30
  ) {
    throw new TypeError("Invalid Device slow_down scheduling input.")
  }
  return Math.min(
    30,
    Math.max(input.previousProtocolIntervalSeconds + 5, input.retryAfterSeconds)
  )
}

/**
 * 为 temporarily_unavailable 生成可持久化的下次轮询时间。
 *
 * Retry-After 是服务暂时不可用的退避时间，不是 RFC 8628 的协议
 * interval。两者分开返回，避免长 Retry-After 被 30 秒协议上限截断。
 */
export function resolveTemporaryUnavailablePollSchedule(input: {
  responseReceivedAt: string
  protocolIntervalSeconds: number
  retryAfterSeconds: number | null
}): DevicePollSchedule {
  const receivedAtMs = new Date(input.responseReceivedAt).getTime()
  if (
    !Number.isFinite(receivedAtMs) ||
    !Number.isSafeInteger(input.protocolIntervalSeconds) ||
    input.protocolIntervalSeconds < 1 ||
    input.protocolIntervalSeconds > 30
  ) {
    throw new TypeError("Invalid Device poll scheduling input.")
  }

  const nextPollDelaySeconds =
    input.retryAfterSeconds !== null &&
    Number.isSafeInteger(input.retryAfterSeconds) &&
    input.retryAfterSeconds >= 1 &&
    input.retryAfterSeconds <= OAUTH_RETRY_AFTER_MAX_SECONDS
      ? Math.max(input.protocolIntervalSeconds, input.retryAfterSeconds)
      : input.protocolIntervalSeconds

  return {
    protocolIntervalSeconds: input.protocolIntervalSeconds,
    nextPollDelaySeconds,
    nextPollAt: new Date(
      receivedAtMs + nextPollDelaySeconds * 1000
    ).toISOString(),
  }
}
