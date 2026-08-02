import { describe, expect, it, vi } from "vitest"
import { CliApplication } from "../src/application.js"
import { createLocalSuccess } from "../src/contracts/envelope.js"
import { CliFailure } from "../src/errors.js"
import { parseArguments } from "../src/parser.js"
import type { AuthService } from "../src/auth/auth-service.js"
import type { ReadCommandService } from "../src/commands/read-service.js"
import type { CliOutcome } from "../src/errors.js"

function success(label: string): CliOutcome {
  return {
    exitCode: 0,
    envelope: createLocalSuccess("skills-entry", { label }),
    warnings: [],
  }
}

function harness(notifier?: { inspect: () => Promise<never> }) {
  const auth = {
    login: vi.fn(() => Promise.resolve(success("login"))),
    status: vi.fn(() => Promise.resolve(success("status"))),
    whoami: vi.fn(() => Promise.resolve(success("whoami"))),
    logout: vi.fn(() => Promise.resolve(success("logout"))),
  }
  const reads = { execute: vi.fn(() => Promise.resolve(success("read"))) }
  const commands = {
    campaignStatus: { status: vi.fn(() => Promise.resolve(success("status"))) },
    commandQuery: { get: vi.fn(() => Promise.resolve(success("get"))) },
    pendingCommands: {
      pending: vi.fn(() => Promise.resolve(success("pending"))),
    },
    commandResume: { resume: vi.fn(() => Promise.resolve(success("resume"))) },
    skills: {
      list: vi.fn(() => Promise.resolve(success("skills-list"))),
      read: vi.fn(() => Promise.resolve(success("skills-read"))),
    },
  }
  return {
    application: new CliApplication(
      auth as unknown as AuthService,
      reads as unknown as ReadCommandService,
      commands,
      notifier
    ),
    auth,
    reads,
    commands,
  }
}

function expectUsage(argv: Array<string>) {
  expect(() => parseArguments(argv)).toThrow(CliFailure)
  try {
    parseArguments(argv)
  } catch (error) {
    expect((error as CliFailure).exitCode).toBe(2)
  }
}

describe("Skills parser and application entry", () => {
  it("parses list, default read, nested read path, and help without a name", () => {
    expect(parseArguments(["skills", "list"]).command).toStrictEqual({
      kind: "skills.list",
    })
    expect(
      parseArguments(["skills", "read", "adrate-shared"]).command
    ).toStrictEqual({ kind: "skills.read", name: "adrate-shared" })
    expect(
      parseArguments(["skills", "read", "adrate-shared", "references/guide.md"])
        .command
    ).toStrictEqual({
      kind: "skills.read",
      name: "adrate-shared",
      path: "references/guide.md",
    })
    const help = parseArguments(["skills", "read", "--help"])
    expect(help.help).toBe(true)
    expect(help.helpTopic).toBe("skills read")
  })

  it("rejects missing names, extra positionals, and auth-only test mode", () => {
    expectUsage(["skills", "read"])
    expectUsage(["skills", "list", "extra"])
    expectUsage(["skills", "read", "adrate-shared", "one", "two"])
    expectUsage(["skills", "list", "--test"])
  })

  it("dispatches both local commands without touching auth or network reads", async () => {
    const value = harness()
    await expect(
      value.application.execute(["skills", "list"])
    ).resolves.toMatchObject({
      outcome: { envelope: { data: { label: "skills-list" } } },
    })
    await expect(
      value.application.execute([
        "skills",
        "read",
        "adrate-ads",
        "references/guide.md",
      ])
    ).resolves.toMatchObject({
      outcome: { envelope: { data: { label: "skills-read" } } },
    })
    expect(value.commands.skills.list).toHaveBeenCalledTimes(1)
    expect(value.commands.skills.read).toHaveBeenCalledWith({
      name: "adrate-ads",
      path: "references/guide.md",
    })
    expect(value.auth.login).not.toHaveBeenCalled()
    expect(value.auth.status).not.toHaveBeenCalled()
    expect(value.reads.execute).not.toHaveBeenCalled()
  })

  it("runs the startup notifier for help, version, success, and parser failure", async () => {
    const inspect = vi.fn(() =>
      Promise.resolve({ notice: null, warning: null })
    )
    const value = harness({ inspect } as never)
    await value.application.execute(["--help"])
    await value.application.execute(["--version"])
    await value.application.execute(["skills", "list"])
    const invalid = await value.application.execute(["unknown-command"])

    expect(inspect).toHaveBeenCalledTimes(4)
    expect(invalid.outcome.exitCode).toBe(2)
  })

  it("does not let a notifier exception change the core command result", async () => {
    const value = harness({
      inspect: vi.fn(() => Promise.reject(new Error("notifier crash"))),
    })
    const execution = await value.application.execute(["skills", "list"])
    expect(execution.outcome.exitCode).toBe(0)
    expect(execution.outcome.envelope).toMatchObject({
      ok: true,
      data: { label: "skills-list" },
    })
    expect(execution.outcome.warnings).toStrictEqual([])
  })
})
