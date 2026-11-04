import { readFile, readdir } from "node:fs/promises"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * 结构守门：CLI 源码保持零子进程。
 *
 * node 进程在后台拉起 powershell / cmd 等子进程，会被企业杀软的行为启发式
 * （如 Symantec SONAR.SuspLaunch）判为可疑启动并杀掉，导致登录等核心链路不可用。
 * 需要系统能力时优先用 Node 内建 API 或原生 addon（如 keytar）。
 */
const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url))
const CHILD_PROCESS_IMPORT =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](?:node:)?child_process["']/u

async function listSourceFiles(directory: string): Promise<Array<string>> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: Array<string> = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await listSourceFiles(path)))
    else if (/\.[cm]?[jt]s$/u.test(entry.name)) files.push(path)
  }
  return files
}

describe("CLI source process boundary", () => {
  it("never imports child_process", async () => {
    const files = await listSourceFiles(SRC_ROOT)
    expect(files.length).toBeGreaterThan(0)
    const offenders: Array<string> = []
    for (const file of files) {
      if (CHILD_PROCESS_IMPORT.test(await readFile(file, "utf8"))) {
        offenders.push(relative(SRC_ROOT, file))
      }
    }
    expect(offenders).toEqual([])
  })
})
