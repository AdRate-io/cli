import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  activeSkillsRoots,
  defaultSkillsRoots,
} from "../src/skills/skills-roots.js"

const roots: Array<string> = []

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "adrate-skills-roots-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("skills roots", () => {
  it("defaults to ~/.agents/skills always and ~/.claude/skills only when ~/.claude exists", async () => {
    const h = await home()
    const specs = defaultSkillsRoots(h)

    expect(await activeSkillsRoots(specs)).toEqual([
      join(h, ".agents", "skills"),
    ])

    await mkdir(join(h, ".claude"))
    expect(await activeSkillsRoots(specs)).toEqual([
      join(h, ".agents", "skills"),
      join(h, ".claude", "skills"),
    ])
  })

  it("treats a symlinked ~/.claude as present but a plain file as absent", async () => {
    if (process.platform === "win32") return
    const h = await home()
    const specs = defaultSkillsRoots(h)
    await writeFile(join(h, ".claude"), "file")
    expect(await activeSkillsRoots(specs)).toHaveLength(1)

    await rm(join(h, ".claude"))
    await mkdir(join(h, "dotfiles-claude"))
    await symlink(join(h, "dotfiles-claude"), join(h, ".claude"))
    expect(await activeSkillsRoots(specs)).toHaveLength(2)
  })
})
