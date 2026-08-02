import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import { DefaultProcessIdentityProbe } from "../src/auth/process-identity.js"
import type {
  NativeProcessResult,
  NativeProcessRunOptions,
  NativeProcessRunner,
} from "../src/storage/native-process.js"

class RecordingRunner implements NativeProcessRunner {
  readonly calls: Array<{
    command: string
    args: ReadonlyArray<string>
    input: string
    options?: NativeProcessRunOptions
  }> = []
  outputs: Array<NativeProcessResult> = []

  run(
    command: string,
    args: ReadonlyArray<string>,
    input = "",
    options?: NativeProcessRunOptions
  ): Promise<NativeProcessResult> {
    this.calls.push({ command, args, input, ...(options ? { options } : {}) })
    return Promise.resolve(
      this.outputs.shift() ?? {
        code: 0,
        stdout: "638896320000000000",
        stderr: "",
      }
    )
  }
}

describe("storage commit process identity", () => {
  it("keeps the Windows PID out of argv and uses fixed encoded input", async () => {
    const runner = new RecordingRunner()
    const probe = new DefaultProcessIdentityProbe({
      platform: "win32",
      pid: 4321,
      runner,
      processSignal: () => undefined,
    })

    await expect(probe.current()).resolves.toEqual({
      pid: 4321,
      fingerprint: "windows:638896320000000000",
    })
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]!.args).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-InputFormat",
      "Text",
      "-EncodedCommand",
      expect.any(String),
    ])
    expect(runner.calls[0]!.args).not.toContain("4321")
    expect(Buffer.from(runner.calls[0]!.input, "base64").toString("utf8")).toBe(
      "4321"
    )
  })

  it("fixes the macOS ps locale and timezone so lstart is stable", async () => {
    const runner = new RecordingRunner()
    runner.outputs.push({
      code: 0,
      stdout: "Thu Jul 31 08:09:10 2026\n",
      stderr: "",
    })
    const probe = new DefaultProcessIdentityProbe({
      platform: "darwin",
      pid: 4321,
      runner,
      processSignal: () => undefined,
    })

    const expected = await probe.current()
    expect(expected).toEqual({
      pid: 4321,
      fingerprint: "posix:Thu Jul 31 08:09:10 2026",
    })
    runner.outputs.push({
      code: 0,
      stdout: "Thu Jul 31 08:09:10 2026\n",
      stderr: "",
    })
    await expect(probe.inspect(expected)).resolves.toBe("same_process")
    runner.outputs.push({
      code: 0,
      stdout: "Thu Jul 31 08:09:11 2026\n",
      stderr: "",
    })
    await expect(probe.inspect(expected)).resolves.toBe("reused")

    expect(runner.calls).toHaveLength(3)
    for (const call of runner.calls) {
      expect(call).toEqual({
        command: "/bin/ps",
        args: ["-p", "4321", "-o", "lstart="],
        input: "",
        options: {
          environment: { LC_ALL: "C", LANG: "C", TZ: "UTC" },
        },
      })
    }

    const deniedRunner = new RecordingRunner()
    const denied = new DefaultProcessIdentityProbe({
      platform: "darwin",
      pid: 4321,
      runner: deniedRunner,
      processSignal() {
        throw Object.assign(new Error("denied"), { code: "EPERM" })
      },
    })
    await expect(denied.inspect(expected)).resolves.toBe("permission_unknown")
    expect(deniedRunner.calls).toHaveLength(0)
  })

  it("distinguishes the same process, PID reuse, ESRCH and permission uncertainty", async () => {
    const runner = new RecordingRunner()
    const signals: Array<"alive" | "dead" | "denied"> = []
    const probe = new DefaultProcessIdentityProbe({
      platform: "win32",
      pid: 4321,
      runner,
      processSignal: () => {
        const signal = signals.shift() ?? "alive"
        if (signal === "alive") return
        const error = new Error(signal)
        ;(error as NodeJS.ErrnoException).code =
          signal === "dead" ? "ESRCH" : "EPERM"
        throw error
      },
    })
    const expected = await probe.current()

    signals.push("alive")
    runner.outputs.push({
      code: 0,
      stdout: "638896320000000000",
      stderr: "",
    })
    await expect(probe.inspect(expected)).resolves.toBe("same_process")

    signals.push("alive")
    runner.outputs.push({
      code: 0,
      stdout: "638896320999999999",
      stderr: "",
    })
    await expect(probe.inspect(expected)).resolves.toBe("reused")

    signals.push("dead")
    await expect(probe.inspect(expected)).resolves.toBe("dead")
    signals.push("denied")
    await expect(probe.inspect(expected)).resolves.toBe("permission_unknown")
  })
})
