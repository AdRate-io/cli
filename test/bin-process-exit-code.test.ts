import { execFile, spawn } from "node:child_process"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { EXIT_CODE } from "../src/constants.js"

/**
 * 进程级退出码合同。
 *
 * 为什么需要它（2026-08-03 Windows 实机验收暴露）：
 * `runner.test.ts` 覆盖的是 `runCli()` 的**返回值**，`src/bin.ts` 里
 * `process.exitCode = await runCli(...)` 这两行不在任何测试覆盖范围内——
 * 它是进程层面的行为，在同一个 vitest 进程里断言不到。真机验收报告一度认为
 * "所有错误路径退出码恒为 0"，而单测全绿、源码赋值链也正确，正是因为
 * 谁都没有真的 spawn 一个子进程去读它的退出状态。
 *
 * 这与烧掉 v0.1.0-beta.3 的缺陷同类：**验证一切的东西，自己的最后一米没人验证。**
 * 所以本文件刻意用真实子进程执行已构建产物，任何"内部算对了但没传播到进程"
 * 的回归都会在这里当场跑红。
 *
 * 覆盖 success(0) 与 usage(2) 两档即可证明整条传播链通畅——business/authentication/
 * retryable/outcomeUnknown 走的是同样那两行，它们的**取值**由 application 层单测覆盖，
 * 这里只负责证明"非零值能到达进程"。刻意不在此处联网或读用户真实状态。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI_ROOT = resolve(HERE, "..")
const BIN = resolve(CLI_ROOT, "dist", "bin.js")
const execFileAsync = promisify(execFile)

let isolatedHome = ""

/** 真实 spawn 子进程，返回进程退出码（不是内部计算值）。 */
async function runBin(
  argv: ReadonlyArray<string>
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [BIN, ...argv], {
      // 隔离 HOME/USERPROFILE，避免读到开发机真实 ~/.adrate 与 ~/.agents
      env: {
        ...process.env,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.on("error", rejectPromise)
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr })
    })
  })
}

beforeAll(async () => {
  isolatedHome = await mkdtemp(join(tmpdir(), "adrate-bin-exit-"))
  // 产物缺失时自己构建，绝不静默跳过：跳过等于把这条缝重新盖上。
  try {
    await access(BIN)
  } catch {
    await execFileAsync("pnpm", ["run", "build"], {
      cwd: CLI_ROOT,
      encoding: "utf8",
      env: { ...process.env, CI: "1" },
      maxBuffer: 8 * 1024 * 1024,
    })
    await access(BIN)
  }
}, 180_000)

afterAll(async () => {
  if (isolatedHome) await rm(isolatedHome, { recursive: true, force: true })
})

describe("dist/bin.js 进程退出码", () => {
  it("成功路径退出码为 0", async () => {
    const version = await runBin(["--version"])
    expect(version.code).toBe(EXIT_CODE.success)

    const help = await runBin(["--help"])
    expect(help.code).toBe(EXIT_CODE.success)
  })

  it("未知命令的非零退出码传播到进程", async () => {
    const result = await runBin(["badcommand"])
    // 关键断言：不是"内部算出了 2"，而是操作系统看到的退出码是 2
    expect(result.code).toBe(EXIT_CODE.usage)
    expect(result.stderr).toContain("Unknown command")
  })

  it("缺少必需参数的非零退出码传播到进程", async () => {
    const result = await runBin(["commands", "get"])
    expect(result.code).toBe(EXIT_CODE.usage)
  })

  it("非零退出码不因 --json 而丢失", async () => {
    const result = await runBin(["badcommand", "--json"])
    expect(result.code).toBe(EXIT_CODE.usage)
    expect(JSON.parse(result.stdout).ok).toBe(false)
  })
})
