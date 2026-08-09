import { describe, expect, it, vi } from "vitest"
import { BudgetCommandService } from "../src/commands/budget-command-service.js"
import { CliFailure } from "../src/errors.js"
import { PublicHttpClient } from "../src/http/client.js"
import type { LocalCredentialCoordinator } from "../src/auth/local-credentials.js"
import type { PendingCommandRepository } from "../src/commands/pending-command-repository.js"
import type { StatusCommandDispatcher } from "../src/commands/status-command-dispatcher.js"
import type { HttpTransport } from "../src/http/client.js"

function createHarness() {
  const stopAfterValidation = new Error("stop after validation")
  const requireLocated = vi.fn(() => Promise.reject(stopAfterValidation))
  const prepare = vi.fn()
  const dispatch = vi.fn()
  const transportRequest = vi.fn()
  const http = new PublicHttpClient({
    request: transportRequest,
  } as unknown as HttpTransport)
  const service = new BudgetCommandService(
    http,
    { requireLocated } as unknown as LocalCredentialCoordinator,
    { prepare } as unknown as PendingCommandRepository,
    {
      generateIdempotencyKey: () => "budget_key",
      dispatcher: { dispatch } as unknown as Pick<
        StatusCommandDispatcher,
        "dispatch"
      >,
    }
  )
  return {
    service,
    stopAfterValidation,
    requireLocated,
    prepare,
    dispatch,
    transportRequest,
  }
}

function input(value: string) {
  return {
    advId: "70001",
    campaignId: "80001",
    mode: "set",
    value,
  }
}

describe("BudgetCommandService preflight", () => {
  it.each(["1", "1.2", "1.23", "1.230", "1e2"])(
    "accepts the server-equivalent value %s before credential lookup",
    async (value) => {
      const harness = createHarness()

      await expect(harness.service.budget(input(value))).rejects.toBe(
        harness.stopAfterValidation
      )
      expect(harness.requireLocated).toHaveBeenCalledOnce()
    }
  )

  it.each(["1.234", "0.001", "1.005"])(
    "rejects over-precision value %s without side effects",
    async (value) => {
      const harness = createHarness()
      let failure: unknown
      try {
        await harness.service.budget(input(value))
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
})
