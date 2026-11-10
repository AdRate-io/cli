import { stat } from "node:fs/promises"
import { join } from "node:path"

/**
 * Agent Skills 安装根目录配置。
 *
 * 不同 Agent 客户端读取不同目录：Codex / Gemini CLI 等读 `~/.agents/skills`，
 * Claude Code 只读 `~/.claude/skills`（2026-11-10 实测）。客户端专属目录只在
 * 该客户端的配置目录已存在时启用，避免给没装 Claude Code 的用户凭空创建
 * `~/.claude/` 或持续提示 missing；之后装了客户端，下一条命令会自然提示安装。
 */
export interface SkillsRootSpec {
  /** 安装根目录（绝对路径） */
  path: string
  /** 仅当该目录存在时才启用 path；省略表示总是启用 */
  activeWhenDirExists?: string
}

export function defaultSkillsRoots(home: string): Array<SkillsRootSpec> {
  return [
    { path: join(home, ".agents", "skills") },
    {
      path: join(home, ".claude", "skills"),
      activeWhenDirExists: join(home, ".claude"),
    },
  ]
}

/** 存在性只是「用过该客户端」的信号，允许是软链；读不到（非 ENOENT/ENOTDIR）按启用处理，让后续校验把错误暴露出来 */
async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return false
    }
    return true
  }
}

/** 按配置顺序返回当前启用的安装根目录（install / 自动升级 / status / notifier 共用的唯一判定） */
export async function activeSkillsRoots(
  specs: ReadonlyArray<SkillsRootSpec>
): Promise<Array<string>> {
  const active: Array<string> = []
  for (const spec of specs) {
    if (
      spec.activeWhenDirExists === undefined ||
      (await dirExists(spec.activeWhenDirExists))
    ) {
      active.push(spec.path)
    }
  }
  return active
}
