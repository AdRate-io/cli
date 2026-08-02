import { describe, expect, it, vi } from "vitest"
import { CliApplication } from "../src/application.js"
import { createLocalSuccess } from "../src/contracts/envelope.js"
import { outcomeUnknownFailure } from "../src/errors.js"
import { runCli } from "../src/runner.js"
import type { AuthService } from "../src/auth/auth-service.js"
import type { ReadCommandService } from "../src/commands/read-service.js"
import type { CliOutcome } from "../src/errors.js"
import type { AcknowledgedOutputStream } from "../src/output.js"

function successOutcome(): CliOutcome {
  return {
    exitCode: 0,
    envelope: createLocalSuccess("runner_request", { revoked: true }),
    warnings: ["safe warning"],
  }
}

function unknownOutcome(): CliOutcome {
  return {
    exitCode: 5,
    envelope: outcomeUnknownFailure("remote unknown").envelope,
    warnings: [],
  }
}

function applicationWithLogout(input: {
  outcome: CliOutcome
  acknowledge: () => Promise<void>
}): CliApplication {
  const auth = {
    login: vi.fn(),
    status: vi.fn(),
    whoami: vi.fn(),
    logout: vi.fn(() =>
      Promise.resolve({
        ...input.outcome,
        postRenderAcknowledgement: { acknowledge: input.acknowledge },
      })
    ),
  }
  const reads = { execute: vi.fn() }
  return new CliApplication(
    auth as unknown as AuthService,
    reads as unknown as ReadCommandService,
    {
      campaignStatus: { status: vi.fn() },
      commandQuery: { get: vi.fn() },
      pendingCommands: { pending: vi.fn() },
      commandResume: { resume: vi.fn() },
      skills: { list: vi.fn(), read: vi.fn() },
    }
  )
}

class ControlledStream implements AcknowledgedOutputStream {
  readonly values: Array<string> = []
  readonly callbacks: Array<(error?: Error | null) => void> = []

  write(value: string, callback: (error?: Error | null) => void): boolean {
    this.values.push(value)
    this.callbacks.push(callback)
    // false 仍表示 chunk 已进入 stream 缓冲；runner 必须等待 callback，不能
    // 把 write 返回值误当作投递确认。
    return false
  }

  completeNext(error?: Error): void {
    const callback = this.callbacks.shift()
    if (!callback) throw new Error("No pending write callback")
    callback(error)
  }
}

class AutoStream implements AcknowledgedOutputStream {
  readonly values: Array<string> = []

  constructor(private readonly firstError: Error | null = null) {}

  write(value: string, callback: (error?: Error | null) => void): boolean {
    this.values.push(value)
    const error = this.values.length === 1 ? this.firstError : null
    queueMicrotask(() => callback(error))
    return true
  }
}

describe("real CLI output acknowledgement boundary", () => {
  it("extracts the internal ack in CliApplication and waits for every write callback before CAS", async () => {
    const acknowledge = vi.fn(() => Promise.resolve())
    const application = applicationWithLogout({
      outcome: successOutcome(),
      acknowledge,
    })
    const stdout = new ControlledStream()
    const stderr = new ControlledStream()

    const running = runCli(
      application,
      ["auth", "logout", "--json", "--verbose"],
      { stdout, stderr }
    )
    await vi.waitFor(() => expect(stdout.callbacks).toHaveLength(1))
    expect(acknowledge).not.toHaveBeenCalled()

    stdout.completeNext()
    await vi.waitFor(() => expect(stderr.callbacks).toHaveLength(1))
    expect(acknowledge).not.toHaveBeenCalled()
    stderr.completeNext()
    await vi.waitFor(() => expect(stderr.callbacks).toHaveLength(1))
    expect(acknowledge).not.toHaveBeenCalled()
    stderr.completeNext()

    await expect(running).resolves.toBe(0)
    expect(acknowledge).toHaveBeenCalledTimes(1)
    expect(stdout.values.join("")).toContain('"revoked":true')
    expect(stderr.values.join("")).toContain("Warning: safe warning")
    expect(stderr.values.join("")).toContain("exitCode=0")
  })

  it("retains the journal when render callback fails and never leaks the error payload", async () => {
    const acknowledge = vi.fn(() => Promise.resolve())
    const application = applicationWithLogout({
      outcome: successOutcome(),
      acknowledge,
    })
    const stdout = new AutoStream(
      new Error("adr_owner_secret-token-render-failure")
    )
    const stderr = new AutoStream()

    await expect(
      runCli(application, ["auth", "logout", "--json"], { stdout, stderr })
    ).resolves.toBe(1)
    expect(acknowledge).not.toHaveBeenCalled()
    expect(stderr.values.join("")).toContain("output delivery failed")
    expect(stderr.values.join("")).not.toContain("secret-token")
  })

  it.each([
    [successOutcome(), 1],
    [unknownOutcome(), 5],
  ] as Array<[CliOutcome, number]>)(
    "retains the journal on ack failure and returns safe exit %s",
    async (outcome, expectedExitCode) => {
      const acknowledge = vi.fn(() =>
        Promise.reject(new Error("adr_owner_secret-token-ack-failure"))
      )
      const application = applicationWithLogout({ outcome, acknowledge })
      const stdout = new AutoStream()
      const stderr = new AutoStream()

      await expect(
        runCli(application, ["auth", "logout", "--json"], {
          stdout,
          stderr,
        })
      ).resolves.toBe(expectedExitCode)
      expect(acknowledge).toHaveBeenCalledTimes(1)
      expect(stderr.values.join("")).toContain(
        "delivery acknowledgement failed"
      )
      expect(stderr.values.join("")).not.toContain("secret-token")
    }
  )
})
