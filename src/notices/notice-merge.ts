import { isPlainObject } from "../contracts/json.js"
import type { CliEnvelope } from "../contracts/envelope.js"
import type { JsonObject } from "../contracts/json.js"

/**
 * 仅替换一个由本地 CLI 拥有的 notice key，并保留其它独立 notice。
 * 调用方必须传入自己构造且验证过的 JSON，不能把服务端同名 key 当事实复用。
 */
export function replaceLocalNotice(
  envelope: CliEnvelope,
  key: "skills",
  value: JsonObject | null
): CliEnvelope {
  const current = envelope.meta._notice
  const preserved: JsonObject = {}
  const define = (noticeKey: string, noticeValue: JsonObject[string]) => {
    Object.defineProperty(preserved, noticeKey, {
      value: noticeValue,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  if (isPlainObject(current)) {
    for (const [currentKey, currentValue] of Object.entries(current)) {
      if (currentKey !== key) define(currentKey, currentValue)
    }
  }
  if (value) define(key, value)
  const { _notice: _ignored, ...metaWithoutNotice } = envelope.meta
  const meta =
    Object.keys(preserved).length === 0
      ? metaWithoutNotice
      : { ...metaWithoutNotice, _notice: preserved }
  return { ...envelope, meta } as CliEnvelope
}
