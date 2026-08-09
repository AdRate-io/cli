import { describe, expect, it, vi } from "vitest"
import { GmvMaxCommandService } from "../src/commands/gmvmax-command-service.js"
import { createLocalSuccess } from "../src/contracts/envelope.js"
import { CliFailure } from "../src/errors.js"
import { PublicHttpClient } from "../src/http/client.js"
import type {
  LocalCredentialCoordinator,
  LocatedCredential,
} from "../src/auth/local-credentials.js"
import type { PendingCommandRepository } from "../src/commands/pending-command-repository.js"
import type { StatusCommandDispatcher } from "../src/commands/status-command-dispatcher.js"
import type { HttpTransport } from "../src/http/client.js"

const LOCATED = {
  index: {
    credentialId: "11111111-1111-4111-8111-111111111111",
    issuerOrigin: "https://api.adrate.io",
  },
  credentials: { teamId: 42 },
} as unknown as LocatedCredential

function createHarness(options: { stopAfterValidation?: boolean } = {}) {
  const stop = new Error("stop after validation")
  const requireLocated = vi.fn(() =>
    options.stopAfterValidation
      ? Promise.reject(stop)
      : Promise.resolve(LOCATED)
  )
  const record = { recordId: "pending-gmv" }
  const prepare = vi.fn(() =>
    Promise.resolve({ kind: "created", record } as const)
  )
  const outcome = {
    exitCode: 0 as const,
    envelope: createLocalSuccess("gmv-command", { commandId: "command-1" }),
    warnings: [],
  }
  const dispatch = vi.fn(() => Promise.resolve(outcome))
  const generateIdempotencyKey = vi.fn(() => "generated_gmv_key")
  const transportRequest = vi.fn()
  const http = new PublicHttpClient({
    request: transportRequest,
  } as unknown as HttpTransport)
  const service = new GmvMaxCommandService(
    http,
    { requireLocated } as unknown as LocalCredentialCoordinator,
    { prepare } as unknown as PendingCommandRepository,
    {
      now: () => new Date("2026-08-08T00:00:00.000Z"),
      generateIdempotencyKey,
      dispatcher: { dispatch } as unknown as Pick<
        StatusCommandDispatcher,
        "dispatch"
      >,
    }
  )
  return {
    service,
    stop,
    record,
    requireLocated,
    prepare,
    dispatch,
    generateIdempotencyKey,
    transportRequest,
    outcome,
  }
}

function common() {
  return {
    advId: "70001",
    campaignId: "80001",
    authId: "9",
  }
}

describe("GmvMaxCommandService", () => {
  it.each([
    ["status", { ...common(), desiredStatus: "future" }],
    [
      "status",
      { advId: "70001", campaignId: "80001", desiredStatus: "enable" },
    ],
    ["budget", { ...common(), mode: "set", value: "1.234" }],
    ["roas", { ...common(), mode: "set", value: "2.55" }],
    ["budget", { ...common(), mode: "decrease_percent", value: "100" }],
    ["roas", { ...common(), mode: "decrease_percent", value: "101" }],
  ] as const)(
    "%s 非法输入在凭据、journal 和网络前拒绝",
    async (method, input) => {
      const harness = createHarness()
      let failure: unknown
      try {
        await harness.service[method](input)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(CliFailure)
      expect(failure).toMatchObject({ exitCode: 2 })
      expect(harness.requireLocated).not.toHaveBeenCalled()
      expect(harness.prepare).not.toHaveBeenCalled()
      expect(harness.dispatch).not.toHaveBeenCalled()
      expect(harness.transportRequest).not.toHaveBeenCalled()
    }
  )

  it.each([
    ["budget", "1.23"],
    ["budget", "1.230"],
    ["roas", "2.5"],
    ["roas", "2.50"],
  ] as const)("%s 接受与服务端一致的精度 %s", async (method, value) => {
    const harness = createHarness({ stopAfterValidation: true })
    await expect(
      harness.service[method]({ ...common(), mode: "set", value })
    ).rejects.toBe(harness.stop)
    expect(harness.requireLocated).toHaveBeenCalledOnce()
  })

  it.each([
    [
      "status",
      { ...common(), desiredStatus: "disable", requestId: "gmv_request" },
      "gmvmax.campaign.status.write",
      { desiredStatus: "DISABLE" },
    ],
    [
      "budget",
      { ...common(), mode: "increase_amount", value: "25.5" },
      "gmvmax.campaign.budget.write",
      { mode: "increase_amount", value: 25.5 },
    ],
    [
      "roas",
      { ...common(), mode: "set", value: "2.5" },
      "gmvmax.campaign.roas.write",
      { mode: "set", value: 2.5 },
    ],
  ] as const)(
    "%s 只生成一次 Key，写入 v2 intent 后复用现有 dispatcher",
    async (method, input, capabilityId, familyPayload) => {
      const harness = createHarness()
      await expect(harness.service[method](input)).resolves.toBe(
        harness.outcome
      )

      expect(harness.generateIdempotencyKey).toHaveBeenCalledOnce()
      expect(harness.prepare).toHaveBeenCalledWith({
        idempotencyKey: "generated_gmv_key",
        capabilityId,
        credentialId: LOCATED.index.credentialId,
        issuerOrigin: LOCATED.index.issuerOrigin,
        teamId: 42,
        intent: {
          capabilityId,
          advId: "70001",
          campaignId: "80001",
          authId: 9,
          familyPayload,
        },
        now: new Date("2026-08-08T00:00:00.000Z"),
      })
      expect(harness.dispatch).toHaveBeenCalledWith({
        record: harness.record,
        expectedCredential: LOCATED,
        ...(method === "status" ? { requestId: "gmv_request" } : {}),
      })
      expect(harness.transportRequest).not.toHaveBeenCalled()
    }
  )

  it("显式 Key 原样绑定，不额外生成", async () => {
    const harness = createHarness()
    await harness.service.roas({
      ...common(),
      mode: "set",
      value: "2.5",
      idempotencyKey: "explicit_gmv_key",
    })
    expect(harness.generateIdempotencyKey).not.toHaveBeenCalled()
    expect(harness.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "explicit_gmv_key" })
    )
  })
})
