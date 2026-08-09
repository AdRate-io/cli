/**
 * 规则写入与 Campaign Copy submit 两类 receipt 写共用的失败提示。
 *
 * 服务端返回 `retryable: false` 并不等于"证明这次写从未落地"：
 * `IDEMPOTENCY_CONFLICT`（409 + retryable=false）恰恰意味着同一个 Key
 * 之前那次写很可能已经提交成功，只是本次请求体与首次不一致。此时若提示
 * Agent 换新 Key 重放，会真实地再创建一条规则或一个复制任务。
 *
 * 因此除了确实证明"未执行"的白名单错误码（INVALID_REQUEST /
 * PLAN_LIMIT_EXCEEDED 等入参类拒绝）之外，兜底一律保守：保留原 Key、
 * 先查证当前状态，不要盲目换新 Key。
 */
export function unprovenWriteReplayWarning(idempotencyKey: string): string {
  return `Keep the original idempotency key ${idempotencyKey} for exact replay or diagnosis; verify the current state before writing again, and do not generate a new key because the server did not prove the write was never applied.`
}
