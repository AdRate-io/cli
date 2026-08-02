import { readFile } from "node:fs/promises"
import { Buffer } from "node:buffer"
import { DefaultNativeProcessRunner } from "../storage/native-process.js"
import { trustedWindowsPowerShellPath } from "../storage/windows-acl.js"
import { dependencyFailure } from "../errors.js"
import type { NativeProcessRunner } from "../storage/native-process.js"

const WINDOWS_PROCESS_IDENTITY_SCRIPT = `
$ErrorActionPreference = "Stop"
try {
  $encodedInput = @($input) -join ""
  if ([string]::IsNullOrWhiteSpace($encodedInput) -or
      $encodedInput.Length -gt 128) { exit 23 }
  $processIdText = [System.Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($encodedInput)
  )
  if ($processIdText -notmatch '^[1-9][0-9]{0,9}$') { exit 23 }
  $processIdValue = [int]::Parse(
    $processIdText,
    [Globalization.CultureInfo]::InvariantCulture
  )
  $target = Get-Process -Id $processIdValue
  [Console]::Out.Write(
    $target.StartTime.ToUniversalTime().Ticks.ToString(
      [Globalization.CultureInfo]::InvariantCulture
    )
  )
} catch {
  exit 23
}
`

const STABLE_MACOS_PROCESS_ENVIRONMENT: NodeJS.ProcessEnv = Object.freeze({
  LC_ALL: "C",
  LANG: "C",
  TZ: "UTC",
})

export interface ProcessIdentity {
  pid: number
  fingerprint: string
}

export type ProcessIdentityStatus =
  | "same_process"
  | "dead"
  | "reused"
  | "permission_unknown"

export interface ProcessIdentityProbe {
  current: () => Promise<ProcessIdentity>
  inspect: (expected: ProcessIdentity) => Promise<ProcessIdentityStatus>
}

interface ProcessIdentityProbeOptions {
  platform?: NodeJS.Platform
  pid?: number
  processSignal?: (pid: number, signal: 0) => void | Promise<void>
  runner?: NativeProcessRunner
}

/**
 * 只在 staging storage commit 超过租约后探测进程实例。PID 本身会复用，
 * 因此必须连同操作系统提供的进程启动标识一起比较；无法证明时一律 busy。
 */
export class DefaultProcessIdentityProbe implements ProcessIdentityProbe {
  private readonly platform: NodeJS.Platform
  private readonly pid: number
  private readonly processSignal: (
    pid: number,
    signal: 0
  ) => void | Promise<void>
  private readonly runner: NativeProcessRunner
  private currentIdentity: Promise<ProcessIdentity> | null = null

  constructor(options: ProcessIdentityProbeOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.pid = options.pid ?? process.pid
    this.processSignal =
      options.processSignal ??
      ((pid, signal) => {
        process.kill(pid, signal)
      })
    this.runner = options.runner ?? new DefaultNativeProcessRunner()
  }

  current(): Promise<ProcessIdentity> {
    this.currentIdentity ??= this.readIdentity(this.pid).catch(() => {
      throw dependencyFailure(
        "The CLI could not establish a stable process identity for secure Token storage."
      )
    })
    return this.currentIdentity
  }

  async inspect(expected: ProcessIdentity): Promise<ProcessIdentityStatus> {
    const liveness = await this.signal(expected.pid)
    if (liveness !== "alive") return liveness
    try {
      const current = await this.readIdentity(expected.pid)
      return current.fingerprint === expected.fingerprint
        ? "same_process"
        : "reused"
    } catch {
      // 查询启动标识和 kill(0) 之间可能恰好退出；再次确认 ESRCH 才能恢复。
      const repeated = await this.signal(expected.pid)
      return repeated === "alive" ? "permission_unknown" : repeated
    }
  }

  private async signal(
    pid: number
  ): Promise<"alive" | "dead" | "permission_unknown"> {
    try {
      await this.processSignal(pid, 0)
      return "alive"
    } catch (error) {
      if (isNodeError(error) && error.code === "ESRCH") return "dead"
      return "permission_unknown"
    }
  }

  private async readIdentity(pid: number): Promise<ProcessIdentity> {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid pid")
    const fingerprint =
      this.platform === "linux"
        ? await readLinuxFingerprint(pid)
        : this.platform === "win32"
          ? await this.readWindowsFingerprint(pid)
          : await this.readPosixFingerprint(pid)
    return { pid, fingerprint }
  }

  private async readPosixFingerprint(pid: number): Promise<string> {
    const result = await this.runner.run(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart="],
      "",
      this.platform === "darwin"
        ? { environment: STABLE_MACOS_PROCESS_ENVIRONMENT }
        : undefined
    )
    const value = normalizeSingleLine(result.stdout)
    if (result.code !== 0 || value === null) throw new Error("ps failed")
    return `posix:${value}`
  }

  private async readWindowsFingerprint(pid: number): Promise<string> {
    const result = await this.runner.run(
      trustedWindowsPowerShellPath(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-InputFormat",
        "Text",
        "-EncodedCommand",
        Buffer.from(WINDOWS_PROCESS_IDENTITY_SCRIPT, "utf16le").toString(
          "base64"
        ),
      ],
      Buffer.from(String(pid), "utf8").toString("base64")
    )
    const value = normalizeSingleLine(result.stdout)
    if (result.code !== 0 || value === null || !/^\d+$/u.test(value)) {
      throw new Error("Get-Process failed")
    }
    return `windows:${value}`
  }
}

async function readLinuxFingerprint(pid: number): Promise<string> {
  const [bootIdText, statText] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readFile(`/proc/${pid}/stat`, "utf8"),
  ])
  const bootId = bootIdText.trim()
  const close = statText.lastIndexOf(")")
  if (
    !/^[0-9a-f-]{36}$/u.test(bootId) ||
    close < 0 ||
    close + 2 >= statText.length
  ) {
    throw new Error("invalid proc identity")
  }
  // /proc/<pid>/stat 在 comm 后从 field 3 开始，field 22 为数组下标 19。
  const fields = statText
    .slice(close + 2)
    .trim()
    .split(/\s+/u)
  const startTicks = fields[19]
  if (!startTicks || !/^\d+$/u.test(startTicks)) {
    throw new Error("invalid proc start time")
  }
  return `linux:${bootId}:${startTicks}`
}

function normalizeSingleLine(value: string): string | null {
  const normalized = value.trim().replace(/\s+/gu, " ")
  if (
    normalized.length === 0 ||
    normalized.length > 192 ||
    [...normalized].some((character) => {
      const code = character.codePointAt(0)
      return code !== undefined && (code <= 0x1f || code === 0x7f)
    })
  ) {
    return null
  }
  return normalized
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
