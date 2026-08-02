import { spawn } from "node:child_process"

const MAX_OUTPUT_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 10_000

export interface NativeProcessResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface NativeProcessRunOptions {
  environment?: NodeJS.ProcessEnv
}

export interface NativeProcessRunner {
  run: (
    command: string,
    args: ReadonlyArray<string>,
    input?: string,
    options?: NativeProcessRunOptions
  ) => Promise<NativeProcessResult>
}

export class NativeProcessError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message)
    this.name = "NativeProcessError"
  }
}

export class DefaultNativeProcessRunner implements NativeProcessRunner {
  constructor(private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {}

  run(
    command: string,
    args: ReadonlyArray<string>,
    input = "",
    options: NativeProcessRunOptions = {}
  ): Promise<NativeProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        ...(options.environment ? { env: options.environment } : {}),
      })
      const stdout: Array<Buffer> = []
      const stderr: Array<Buffer> = []
      let outputBytes = 0
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        callback()
      }
      const timeout = setTimeout(() => {
        child.kill()
        finish(() =>
          reject(new NativeProcessError("Native credential command timed out."))
        )
      }, this.timeoutMs)
      timeout.unref()
      const onData = (target: Array<Buffer>) => (chunk: Buffer) => {
        outputBytes += chunk.byteLength
        if (outputBytes > MAX_OUTPUT_BYTES) {
          child.kill()
          finish(() =>
            reject(
              new NativeProcessError("Native credential output was too large.")
            )
          )
          return
        }
        target.push(chunk)
      }
      child.stdout.on("data", onData(stdout))
      child.stderr.on("data", onData(stderr))
      child.once("error", (error: NodeJS.ErrnoException) => {
        finish(() =>
          reject(
            new NativeProcessError(
              "Native credential command could not start.",
              error.code
            )
          )
        )
      })
      child.once("close", (code) => {
        finish(() =>
          resolve({
            code,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          })
        )
      })
      child.stdin.end(input)
    })
  }
}
