import { describe, expect, it } from "vitest"
import { CliFailure } from "../src/errors.js"
import {
  RAW_PATH_SEGMENT_PATTERN,
  isTransportableResourceId,
  isValidResourceId,
  parseDateOnly,
  parsePositiveInteger,
  requireTransportableResourceId,
} from "../src/contracts/resource-input.js"

function expectUsage(callback: () => unknown): CliFailure {
  try {
    callback()
  } catch (error) {
    expect(error).toBeInstanceOf(CliFailure)
    const failure = error as CliFailure
    expect(failure.exitCode).toBe(2)
    return failure
  }
  throw new Error("Expected a usage failure")
}

describe("Public TikTok opaque resource ID", () => {
  it("保持合法 ID 为 string，不 trim、转 number 或 decode", () => {
    for (const value of [
      "00070001",
      "campaign-A",
      "A_B!~*'().-",
      "9".repeat(50),
    ]) {
      expect(isValidResourceId(value, "advId")).toBe(true)
      expect(requireTransportableResourceId(value, "advId")).toBe(value)
    }
    expect(RAW_PATH_SEGMENT_PATTERN).toBe(
      "^(?!\\.{1,2}$)[A-Za-z0-9_!~*'().-]+$"
    )
  })

  it("业务语义按 code point 长度校验，传输边界再收窄 raw segment", () => {
    const unicodeOpaqueId = "投放账户"
    expect(isValidResourceId(unicodeOpaqueId, "advId")).toBe(true)
    expect(isTransportableResourceId(unicodeOpaqueId, "advId")).toBe(false)
    expectUsage(() => requireTransportableResourceId(unicodeOpaqueId, "advId"))

    const literalPercent = "campaign%GG"
    expect(isValidResourceId(literalPercent, "campaignId")).toBe(true)
    expect(isTransportableResourceId(literalPercent, "campaignId")).toBe(false)
  })

  it.each([
    ["", "advId"],
    [" 70001", "advId"],
    ["70001 ", "advId"],
    ["70\u000001", "advId"],
    ["70\u007f01", "advId"],
    ["a".repeat(51), "advId"],
    ["c".repeat(129), "campaignId"],
  ] as const)("拒绝非法 %s (%s)", (value, kind) => {
    expect(isValidResourceId(value, kind)).toBe(false)
    expectUsage(() => requireTransportableResourceId(value, kind))
  })

  it.each([".", "..", "a/b", "a?b", "a#b", "a b", "a\\b"])(
    "拒绝会改变或混淆 raw pathname 的 ID: %s",
    (value) => {
      expect(isValidResourceId(value, "campaignId")).toBe(true)
      expect(isTransportableResourceId(value, "campaignId")).toBe(false)
      expectUsage(() => requireTransportableResourceId(value, "campaignId"))
    }
  )
})

describe("query integer parsing", () => {
  it.each([
    ["1", 1],
    ["42", 42],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ] as const)("解析 canonical 正安全整数 %s", (value, expected) => {
    expect(parsePositiveInteger(value, "--page")).toBe(expected)
  })

  it.each([
    undefined,
    "",
    "0",
    "-1",
    "+1",
    "01",
    "1.0",
    " 1",
    "1 ",
    String(Number.MAX_SAFE_INTEGER + 1),
  ])("拒绝非 canonical 正安全整数 %s", (value) => {
    expectUsage(() => parsePositiveInteger(value, "--page"))
  })

  it("执行调用方给定上限", () => {
    expect(parsePositiveInteger("1000", "--page-size", 1000)).toBe(1000)
    expectUsage(() => parsePositiveInteger("1001", "--page-size", 1000))
  })
})

describe("Gregorian date-only parsing", () => {
  it("接受真实公历日期并以公历序号稳定计算跨度", () => {
    const leapDay = parseDateOnly("2024-02-29", "--start-date")
    const nextDay = parseDateOnly("2024-03-01", "--end-date")
    expect(nextDay.ordinal - leapDay.ordinal).toBe(1)
    expect(leapDay.value).toBe("2024-02-29")
  })

  it.each([
    undefined,
    "",
    "2026-7-01",
    "2026-07-1",
    "0000-01-01",
    "2026-02-29",
    "2024-02-30",
    "2026-04-31",
    "2026-13-01",
  ])("拒绝非法 date-only %s", (value) => {
    expectUsage(() => parseDateOnly(value, "--start-date"))
  })
})
