import { describe, expect, it } from "vitest"
import { getCliCommandFamily } from "../src/commands/command-families.js"
import { createPreparedPendingCommand } from "../src/commands/pending-command-contract.js"
import type { PendingCommandIntent } from "../src/commands/command-families.js"

function intent(
  capabilityId: PendingCommandIntent["capabilityId"],
  familyPayload: Record<string, unknown>
): PendingCommandIntent {
  return {
    capabilityId,
    advId: "70001",
    campaignId: "80001",
    authId: 9,
    familyPayload,
  }
}

describe("GMV Max CLI Command families", () => {
  it.each([
    [
      "gmvmax.campaign.status.write",
      { desiredStatus: "DISABLE" },
      "status",
      { status: "DISABLE", authId: 9 },
    ],
    [
      "gmvmax.campaign.budget.write",
      { mode: "increase_amount", value: 25.5 },
      "budget",
      { mode: "increase_amount", value: 25.5, authId: 9 },
    ],
    [
      "gmvmax.campaign.roas.write",
      { mode: "set", value: 2.5 },
      "roas",
      { mode: "set", value: 2.5, authId: 9 },
    ],
  ] as const)(
    "%s 构造最终服务端 path/body，不复制业务计算",
    (capabilityId, familyPayload, operation, body) => {
      const family = getCliCommandFamily(capabilityId)
      expect(family).not.toBeNull()
      expect(family!.requiresAuthId).toBe(true)
      const value = intent(capabilityId, familyPayload)
      expect(family!.postPath(value)).toBe(
        `/public/v1/gmvmax/advertisers/70001/campaigns/80001/${operation}`
      )
      expect(family!.postBody(value)).toEqual(body)
      expect(family!.matchesIntentTarget(familyPayload, familyPayload)).toBe(
        true
      )
    }
  )

  it("拒绝缺少 authId 的 GMV Max pending intent", () => {
    expect(() =>
      createPreparedPendingCommand({
        idempotencyKey: "gmv-missing-auth",
        credentialId: "11111111-1111-4111-8111-111111111111",
        issuerOrigin: "https://api.adrate.io",
        teamId: 42,
        capabilityId: "gmvmax.campaign.status.write",
        intent: {
          ...intent("gmvmax.campaign.status.write", {
            desiredStatus: "ENABLE",
          }),
          authId: null,
        },
        now: new Date("2026-08-08T00:00:00.000Z"),
      })
    ).toThrow("Pending Command input is invalid.")
  })
})
