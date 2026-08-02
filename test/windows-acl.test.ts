import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import {
  PowerShellWindowsAclController,
  trustedWindowsPowerShellPath,
} from "../src/storage/windows-acl.js"
import { NativeProcessError } from "../src/storage/native-process.js"
import type {
  NativeProcessResult,
  NativeProcessRunner,
} from "../src/storage/native-process.js"

interface ProcessCall {
  command: string
  args: ReadonlyArray<string>
  input?: string
}

class FakeRunner implements NativeProcessRunner {
  readonly calls: Array<ProcessCall> = []

  constructor(
    private result: NativeProcessResult = {
      code: 0,
      stdout: "OK\n",
      stderr: "",
    },
    private error: Error | null = null
  ) {}

  run(
    command: string,
    args: ReadonlyArray<string>,
    input?: string
  ): Promise<NativeProcessResult> {
    this.calls.push({
      command,
      args,
      ...(input === undefined ? {} : { input }),
    })
    if (this.error) return Promise.reject(this.error)
    return Promise.resolve(this.result)
  }

  setResult(result: NativeProcessResult): void {
    this.result = result
    this.error = null
  }
}

function operation(call: ProcessCall): {
  action: string
  literalPath: string
  kind: string
  targetPath: string
} {
  if (!call.input) throw new Error("missing PowerShell operation input")
  return JSON.parse(Buffer.from(call.input, "base64").toString("utf8")) as {
    action: string
    literalPath: string
    kind: string
    targetPath: string
  }
}

describe("PowerShellWindowsAclController", () => {
  it("requires an absolute Windows helper command", () => {
    expect(
      () => new PowerShellWindowsAclController(new FakeRunner(), "powershell")
    ).toThrow(NativeProcessError)
  })

  it("uses the trusted absolute system PowerShell path and fixed noninteractive invocation", async () => {
    const runner = new FakeRunner()
    const executable = trustedWindowsPowerShellPath({
      SystemRoot: "C:\\Windows",
    })
    const controller = new PowerShellWindowsAclController(runner, executable)

    await controller.ensureDirectory("C:\\Users\\Boss User\\.adrate")
    await controller.secure("C:\\Users\\Boss'的设备\\.adrate\\token", "file")
    await expect(
      controller.verify("C:\\Users\\Boss 用户\\.adrate\\token", "file")
    ).resolves.toBe(true)
    await controller.atomicReplace(
      "C:\\Users\\Boss User\\.adrate\\token 'tmp'",
      "C:\\Users\\Boss 用户\\.adrate\\token"
    )

    expect(runner.calls).toHaveLength(4)
    for (const call of runner.calls) {
      expect(call.command).toBe(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
      )
      expect(call.args.slice(0, 6)).toEqual([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-InputFormat",
        "Text",
        "-EncodedCommand",
      ])
      expect(call.args).toHaveLength(7)
      expect(call.args[6]).toMatch(/^[A-Za-z0-9+/]+=*$/u)
      expect(call.input).toMatch(/^[A-Za-z0-9+/]+=*$/u)
      expect(call.args.join(" ")).not.toContain("Boss")
      expect(call.args.join(" ")).not.toContain("用户")
    }
    expect(new Set(runner.calls.map((call) => call.args[6])).size).toBe(1)
    expect(operation(runner.calls[0]!)).toEqual({
      action: "ensure_directory",
      literalPath: "C:\\Users\\Boss User\\.adrate",
      kind: "directory",
      targetPath: "",
    })
    expect(operation(runner.calls[1]!)).toEqual({
      action: "secure",
      literalPath: "C:\\Users\\Boss'的设备\\.adrate\\token",
      kind: "file",
      targetPath: "",
    })
    expect(operation(runner.calls[2]!)).toEqual({
      action: "verify",
      literalPath: "C:\\Users\\Boss 用户\\.adrate\\token",
      kind: "file",
      targetPath: "",
    })
    expect(operation(runner.calls[3]!)).toEqual({
      action: "replace",
      literalPath: "C:\\Users\\Boss User\\.adrate\\token 'tmp'",
      kind: "file",
      targetPath: "C:\\Users\\Boss 用户\\.adrate\\token",
    })
  })

  it("encodes protected-DACL, reparse rejection, exact-rule, and write-through checks in the fixed helper", async () => {
    const runner = new FakeRunner()
    const controller = new PowerShellWindowsAclController(
      runner,
      trustedWindowsPowerShellPath({ SystemRoot: "C:\\Windows" })
    )

    await controller.verify("C:\\Users\\Boss\\.adrate\\token", "file")

    const encoded = runner.calls[0]!.args[6]!
    const script = Buffer.from(encoded, "base64").toString("utf16le")
    expect(script).toContain('$encodedInput = @($input) -join ""')
    expect(script).toContain("[Convert]::FromBase64String($encodedInput)")
    expect(script).toContain("ConvertFrom-Json -InputObject $json")
    expect(script).not.toContain("param([string]$Action")
    expect(script).toContain("SetAccessRuleProtection($true, $false)")
    expect(script).toContain("AreAccessRulesProtected")
    expect(script).toContain("[IO.FileAttributes]::ReparsePoint")
    expect(script).toContain("$rules.Count -ne 1")
    expect(script).toContain("$MOVEFILE_WRITE_THROUGH = 0x8")
    expect(script).toContain("MoveFileEx")
  })

  it("fails verification closed on nonzero status or ambiguous output", async () => {
    const runner = new FakeRunner({
      code: 18,
      stdout: "",
      stderr: "DACL inherited",
    })
    const controller = new PowerShellWindowsAclController(
      runner,
      trustedWindowsPowerShellPath()
    )

    await expect(
      controller.verify("C:\\Users\\Boss\\.adrate\\token", "file")
    ).resolves.toBe(false)

    runner.setResult({ code: 0, stdout: "not-ok", stderr: "" })
    await expect(
      controller.verify("C:\\Users\\Boss\\.adrate\\token", "file")
    ).resolves.toBe(false)
  })

  it.each([
    ["directory creation", "ensureDirectory"],
    ["ACL hardening", "secure"],
    ["atomic replacement", "atomicReplace"],
  ] as const)(
    "fails %s closed when the helper does not attest OK",
    async (_label, method) => {
      const runner = new FakeRunner({
        code: 1,
        stdout: "",
        stderr: "failed",
      })
      const controller = new PowerShellWindowsAclController(
        runner,
        trustedWindowsPowerShellPath()
      )

      const result =
        method === "ensureDirectory"
          ? controller.ensureDirectory("C:\\Users\\Boss\\.adrate")
          : method === "secure"
            ? controller.secure("C:\\Users\\Boss\\.adrate\\token", "file")
            : controller.atomicReplace(
                "C:\\Users\\Boss\\.adrate\\token.tmp",
                "C:\\Users\\Boss\\.adrate\\token"
              )
      await expect(result).rejects.toBeInstanceOf(NativeProcessError)
    }
  )

  it("propagates helper launch failures instead of pretending ACL verification succeeded", async () => {
    const runner = new FakeRunner(
      { code: null, stdout: "", stderr: "" },
      new NativeProcessError("could not start")
    )
    const controller = new PowerShellWindowsAclController(
      runner,
      trustedWindowsPowerShellPath()
    )

    await expect(
      controller.verify("C:\\Users\\Boss\\.adrate\\token", "file")
    ).rejects.toBeInstanceOf(NativeProcessError)
  })
})

describe("trustedWindowsPowerShellPath", () => {
  it("accepts only an exact drive-root Windows directory", () => {
    expect(trustedWindowsPowerShellPath({ SystemRoot: "D:\\Windows" })).toBe(
      "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    )
    expect(
      trustedWindowsPowerShellPath({
        SystemRoot: "C:\\Windows\\..\\attacker",
      })
    ).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    expect(
      trustedWindowsPowerShellPath({
        SystemRoot: "\\\\server\\share\\Windows",
      })
    ).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
  })
})
