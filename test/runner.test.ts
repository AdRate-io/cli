import { describe, expect, it, vi } from "vitest"
import { CliApplication } from "../src/application.js"
import { createLocalSuccess } from "../src/contracts/envelope.js"
import { runCli } from "../src/runner.js"
import type { AuthService } from "../src/auth/auth-service.js"
import type { ReadCommandService } from "../src/commands/read-service.js"
import type { CliOutcome } from "../src/errors.js"

function successOutcome(): CliOutcome {
  return {
    exitCode: 0,
    envelope: createLocalSuccess("runner_request", { revoked: true }),
    warnings: ["safe warning"],
  }
}

function applicationWithLogout(outcome: CliOutcome): CliApplication {
  const auth = {
    login: vi.fn(),
    status: vi.fn(),
    whoami: vi.fn(),
    logout: vi.fn(() => Promise.resolve(outcome)),
  }
  const reads = { execute: vi.fn() }
  return new CliApplication(
    auth as unknown as AuthService,
    reads as unknown as ReadCommandService,
    {
      campaignStatus: { status: vi.fn() },
      campaignBudget: { budget: vi.fn() },
      gmvMax: { status: vi.fn(), budget: vi.fn(), roas: vi.fn() },
      commandQuery: { get: vi.fn() },
      pendingCommands: { pending: vi.fn() },
      commandResume: { resume: vi.fn() },
      feedback: { submit: vi.fn() },
      copy: { submit: vi.fn(), preview: vi.fn() },
      rules: {
        create: vi.fn(),
        update: vi.fn(),
        enable: vi.fn(),
        disable: vi.fn(),
        delete: vi.fn(),
        dryRun: vi.fn(),
      },
      skills: { list: vi.fn(), read: vi.fn() },
      skillsInstall: { install: vi.fn() },
    }
  )
}

describe("real CLI runner boundary", () => {
  it("renders logout output and returns the service exit code", async () => {
    const stdout: Array<string> = []
    const stderr: Array<string> = []
    const application = applicationWithLogout(successOutcome())

    await expect(
      runCli(application, ["auth", "logout", "--json", "--verbose"], {
        stdout: {
          write(value: string) {
            stdout.push(value)
            return true
          },
        },
        stderr: {
          write(value: string) {
            stderr.push(value)
            return true
          },
        },
      })
    ).resolves.toBe(0)

    expect(stdout.join("")).toContain('"revoked":true')
    expect(stderr.join("")).toContain("Warning: safe warning")
    expect(stderr.join("")).toContain("exitCode=0")
  })
})
