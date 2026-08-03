import { execFile } from "node:child_process"
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import {
  applyMirrorPlan,
  collectMirrorSource,
  createMirrorPlan,
  isAllowedMirrorPath,
} from "../scripts/public-mirror.mjs"

const execFileAsync = promisify(execFile)
const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url))
// 版本号与 channel 从真实 package.json 派生，避免每次升版本都要改这个测试。
const CLI_VERSION = JSON.parse(
  await readFile(join(CLI_ROOT, "package.json"), "utf8")
).version as string
const RELEASE_TAG = `v${CLI_VERSION}`
const RELEASE_CHANNEL = CLI_VERSION.includes("-") ? "prerelease" : "stable"
const EXPECTED_REMOTE = "https://github.com/AdRate-io/cli.git"
const roots: Array<string> = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true }))
  )
})

async function git(
  repository: string,
  ...args: Array<string>
): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repository, ...args], {
    encoding: "utf8",
  })
  return stdout.trim()
}

async function initializeRepository(repository: string) {
  await mkdir(repository, { recursive: true })
  await execFileAsync("git", ["init", "--initial-branch=main", repository])
  await git(repository, "config", "user.email", "mirror-test@adrate.local")
  await git(repository, "config", "user.name", "AdRate Mirror Test")
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "adrate-public-mirror-test-"))
  roots.push(root)
  const privateRepository = join(root, "private")
  const sourceRoot = join(privateRepository, "cli")
  const targetRoot = join(root, "public")
  await initializeRepository(privateRepository)
  await cp(CLI_ROOT, sourceRoot, {
    recursive: true,
    filter(source) {
      const path = relative(CLI_ROOT, source).replaceAll("\\", "/")
      return !(
        path === "dist" ||
        path.startsWith("dist/") ||
        path === ".git" ||
        path.startsWith(".git/") ||
        path === "node_modules" ||
        path.startsWith("node_modules/") ||
        path === ".adrate-public-mirror.json" ||
        path.endsWith(".tgz")
      )
    },
  })
  await git(privateRepository, "add", "cli")
  await git(privateRepository, "commit", "-m", "private source")
  const sourceCommit = await git(privateRepository, "rev-parse", "HEAD")

  await initializeRepository(targetRoot)
  await git(targetRoot, "remote", "add", "origin", EXPECTED_REMOTE)
  await git(targetRoot, "commit", "--allow-empty", "-m", "public base")
  const targetCommit = await git(targetRoot, "rev-parse", "HEAD")
  return {
    root,
    privateRepository,
    sourceRoot,
    sourceCommit,
    targetRoot,
    targetCommit,
  }
}

type MirrorFile = { path: string; sha256: string; content: Buffer }

async function materializeTracked(root: string, tracked: Map<string, Buffer>) {
  for (const [path, content] of tracked) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
}

async function writeMirrorManifest(
  root: string,
  baseTargetCommit: string,
  tracked: Map<string, Buffer>,
  // 默认占位 SHA 够用于只读校验；需要走 createMirrorPlan 的用例必须传真实祖先 commit
  sourceCommit: string = "a".repeat(40)
) {
  const files = [...tracked]
    .map(([path, content]) => ({
      path,
      sha256: createHash("sha256").update(content).digest("hex"),
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
  await writeFile(
    join(root, ".adrate-public-mirror.json"),
    `${JSON.stringify(
      {
        formatVersion: 1,
        sourceCommit,
        baseTargetCommit,
        files,
      },
      null,
      2
    )}\n`
  )
}

/** 复刻一个"镜像工具刚写完并被维护者正常提交"的公开仓库。 */
async function syntheticMirrorTarget(
  source: Array<MirrorFile>,
  sourceCommit?: string
) {
  const root = await mkdtemp(join(tmpdir(), "adrate-mirror-manual-"))
  roots.push(root)
  await initializeRepository(root)
  await git(root, "remote", "add", "origin", EXPECTED_REMOTE)
  await git(root, "commit", "--allow-empty", "-m", "public base")
  const base = await git(root, "rev-parse", "HEAD")
  const tracked = new Map(source.map((file) => [file.path, file.content]))
  await materializeTracked(root, tracked)
  await writeMirrorManifest(root, base, tracked, sourceCommit)
  await git(root, "add", "-A")
  await git(root, "commit", "-m", "mirror commit")
  return { root, tracked, mirrorCommit: await git(root, "rev-parse", "HEAD") }
}

describe("public mirror policy", () => {
  it("accepts the complete current public source and rejects widened paths", async () => {
    const files = await collectMirrorSource(CLI_ROOT)
    const paths = files.map((file) => file.path)
    expect(paths).toContain(".github/workflows/publish.yml")
    expect(paths).toContain("scripts/public-mirror.mjs")
    expect(paths).toContain("integrations/accio/validation.json")
    expect(paths).toContain("release/trusted-evidence-pins.json")
    expect(paths).not.toContain("dist/bin.js")
    expect(paths.some((path) => path.startsWith("node_modules/"))).toBe(false)
    expect(isAllowedMirrorPath("src/bin.ts")).toBe(true)
    expect(
      isAllowedMirrorPath("release/evidence/github-public-mirror.json")
    ).toBe(true)
    expect(isAllowedMirrorPath("release/trusted-evidence-pins.json")).toBe(true)
    expect(isAllowedMirrorPath("release/unreviewed.json")).toBe(false)
    expect(isAllowedMirrorPath("release/evidence/unreviewed-gate.json")).toBe(
      false
    )
    expect(isAllowedMirrorPath("skills/unknown/SKILL.md")).toBe(false)
    expect(isAllowedMirrorPath("private-main-site.ts")).toBe(false)
    // 信任根刻意用 branch ruleset 而非 CODEOWNERS：三个合法位置都在 allowlist 之外，
    // 放进公开仓库会直接触发闭世界阻断。
    // LICENSE 曾在这份名单里，2026-08-03 已按流程加入 allowlist 与精确 15 项
    // tarball 合同（它会被 npm 无条件打包，两者必须一起改），见 release/README.md。
    expect(isAllowedMirrorPath("LICENSE")).toBe(true)
    for (const forbidden of [
      "CODEOWNERS",
      "docs/CODEOWNERS",
      ".github/CODEOWNERS",
    ]) {
      expect(isAllowedMirrorPath(forbidden)).toBe(false)
    }
    for (const unsafe of [
      "src/a b.ts",
      "src/a\tb.ts",
      "src/a\u0000b.ts",
      "src/./a.ts",
      "src/../a.ts",
      "src/a/..",
      "src//a.ts",
    ]) {
      expect(() => isAllowedMirrorPath(unsafe)).toThrow(
        "Mirror path escaped its root"
      )
    }
  })

  /**
   * release/README.md 的"单向镜像"一节给出了公开仓库手工提交的分层阻断表，
   * 而那份 runbook 既不在 assertDocumentation 的冻结文本内，又被 release gate
   * 显式允许在已测候选之后变更。这条用例把表里四行逐条钉成有测试守护的合同：
   * 报错串或先后顺序被改动时必须在这里先红，runbook 不会静默变成错误指引。
   */
  it("按层级钉死公开仓库手工提交的实际阻断点", async () => {
    const source = (await collectMirrorSource(CLI_ROOT)) as Array<MirrorFile>

    // 第 1 行：镜像工具写出并正常提交的自洽状态，工具完全放行。
    const clean = await syntheticMirrorTarget(source)
    await expect(collectMirrorSource(clean.root)).resolves.toHaveLength(
      source.length
    )

    // 第 2 行：手工提交但未重签 manifest —— 父子闭合检查先行拦下。
    // 这里刻意断言的是"父提交/base"这条，而不是 manifest-commit 那条：
    // 手工提交让 HEAD 的父变成上一次镜像提交，而 manifest 记录的 base 更早。
    const noResign = await syntheticMirrorTarget(source)
    await writeFile(join(noResign.root, "CODEOWNERS"), "* @someone\n")
    await git(noResign.root, "add", "-A")
    await git(noResign.root, "commit", "-m", "hand-added CODEOWNERS")
    await expect(collectMirrorSource(noResign.root)).rejects.toThrow(
      "Target mirror commit is not the direct child of its recorded base commit."
    )

    // 第 3 行：手工提交且自洽重签，但引入 allowlist 之外路径 —— manifest 校验拦下。
    // 这里用 CODEOWNERS 而不是 LICENSE：LICENSE 自 2026-08-03 起已进 allowlist，
    // 拿它当"白名单外"的例子会让这条断言恒不成立。
    const outside = await syntheticMirrorTarget(source)
    outside.tracked.set("CODEOWNERS", Buffer.from("* @someone\n"))
    await materializeTracked(outside.root, outside.tracked)
    await writeMirrorManifest(
      outside.root,
      outside.mirrorCommit,
      outside.tracked
    )
    await git(outside.root, "add", "-A")
    await git(outside.root, "commit", "-m", "hand-added CODEOWNERS, re-signed")
    await expect(collectMirrorSource(outside.root)).rejects.toThrow(
      "Target mirror manifest is invalid."
    )

    // 第 4 行：手工提交且自洽重签，只动 allowlist 内路径 —— 工具不阻断。
    // 这条断言的是一个已知缺口：唯一防线是 branch ruleset，不是本脚本。
    // 若将来工具真的能拦住它，这里会失败，届时必须同步更新 runbook 那张表。
    const inside = await syntheticMirrorTarget(source)
    inside.tracked.set(
      "release/README.md",
      Buffer.from("hand edited runbook\n")
    )
    await materializeTracked(inside.root, inside.tracked)
    await writeMirrorManifest(inside.root, inside.mirrorCommit, inside.tracked)
    await git(inside.root, "add", "-A")
    await git(inside.root, "commit", "-m", "hand-edited runbook, re-signed")
    await expect(collectMirrorSource(inside.root)).resolves.toHaveLength(
      source.length
    )
  }, 60_000)

  /**
   * 回归（2026-08-03 实际踩中）：往 REQUIRED_FILES 新增一个文件，会让**写于该文件
   * 存在之前**的 prior manifest 立刻被判 "Target mirror manifest is invalid."，
   * 此后每一次镜像同步都被拒，错误信息完全指不到根因。
   *
   * 既有用例抓不到它，因为 syntheticMirrorTarget 是**从当前 source 造 target**，
   * 目标里永远已经含有全部必需文件——"历史 manifest 早于新增要求"这条路径从未被走过。
   */
  it("历史 manifest 缺少后来才加入 REQUIRED_FILES 的文件时，仍能继续镜像", async () => {
    // 用 fixture() 造独立私有仓库，而不是直接用 CLI_ROOT：本用例会在"镜像出来的
    // 公开仓库"里再跑一遍，那里 CLI_ROOT 是公开根（带 manifest），不能当 source。
    const f = await fixture()
    const source = (await collectMirrorSource(
      f.sourceRoot
    )) as Array<MirrorFile>
    const laterRequired = "scripts/secret-patterns.mjs"
    expect(source.some((file) => file.path === laterRequired)).toBe(true)

    // 造一个"该文件尚不存在"的历史目标：manifest 与工作树都不含它。
    // 这个状态今天已经无法用工具生成（source 侧会拒），只能手工构造 —— 这正是
    // 缺陷能长期潜伏的原因。
    const legacy = source.filter((file) => file.path !== laterRequired)
    const target = await syntheticMirrorTarget(legacy, f.sourceCommit)
    expect(target.tracked.has(laterRequired)).toBe(false)

    // 关键断言：同步计划路径（inspectMirrorTarget -> parsePriorManifest）必须仍能
    // 解析这份历史 manifest 并把缺的文件补上，而不是抛 "Target mirror manifest
    // is invalid." 死锁。
    //
    // 刻意**不**断言 collectMirrorSource(target.root)：那条是"把公开仓库当作发布
    // 候选读取"的闸门语义，在那里强制 REQUIRED_FILES 是正确的 —— 候选就是即将
    // 发布的东西，缺必需文件必须拒。两种语义不能混。
    const plan = await createMirrorPlan({
      sourceRoot: f.sourceRoot,
      targetRoot: target.root,
      sourceCommit: f.sourceCommit,
      targetCommit: target.mirrorCommit,
    })
    expect(plan.summary.added).toContain(laterRequired)
  }, 60_000)

  it("rejects sensitive filenames before reading and credential-shaped content", async () => {
    const root = await mkdtemp(join(tmpdir(), "adrate-mirror-secret-"))
    roots.push(root)
    await writeFile(join(root, ".env"), "should-not-be-read", { mode: 0o000 })
    await expect(collectMirrorSource(root)).rejects.toThrow(
      "outside the mirror allowlist"
    )

    await rm(join(root, ".env"))
    await mkdir(join(root, "src"))
    await writeFile(
      join(root, "src", "leak.ts"),
      `export const leaked = ${JSON.stringify(`npm_${"A".repeat(40)}`)}\n`
    )
    await expect(collectMirrorSource(root)).rejects.toThrow(
      "Mirror secret scan rejected"
    )

    await rm(join(root, "src", "leak.ts"))
    await writeFile(
      join(root, "src", "owner-leak.ts"),
      `export const token = "adr_owner_11111111-2222-4333-8444-555555555555_${"A".repeat(43)}"\n`
    )
    await expect(collectMirrorSource(root)).rejects.toThrow(
      "Mirror secret scan rejected"
    )
  })
})

describe("public mirror commit and apply gates", () => {
  it("uses captured bytes, closes the manifest ancestry, and rejects plan/apply races", async () => {
    const f = await fixture()
    const sourceReadme = await readFile(join(f.sourceRoot, "README.md"))
    const initialPlan = await createMirrorPlan({
      sourceRoot: f.sourceRoot,
      sourceCommit: f.sourceCommit,
      targetRoot: f.targetRoot,
      targetCommit: f.targetCommit,
      testHooks: {
        afterSourceCheckoutValidated: async () => {
          await writeFile(
            join(f.sourceRoot, "README.md"),
            "unapproved source read race\n"
          )
        },
      },
    })
    expect(initialPlan.summary.added.length).toBeGreaterThan(100)
    expect(initialPlan.summary.updated).toStrictEqual([])
    expect(initialPlan.summary.removed).toStrictEqual([])
    expect(
      initialPlan.files.find((file) => file.path === "README.md")?.content
    ).toStrictEqual(sourceReadme)

    // Source can change after planning; apply must write only approved captured bytes.
    const targetIndexBeforeApply = await git(f.targetRoot, "write-tree")
    await applyMirrorPlan(initialPlan)
    expect(await git(f.targetRoot, "write-tree")).toBe(targetIndexBeforeApply)
    expect(await readFile(join(f.targetRoot, "README.md"))).toStrictEqual(
      sourceReadme
    )
    const manifest = JSON.parse(
      await readFile(join(f.targetRoot, ".adrate-public-mirror.json"), "utf8")
    ) as {
      sourceCommit: string
      baseTargetCommit: string
      files: Array<{ path: string; sha256: string }>
    }
    expect(manifest.sourceCommit).toBe(f.sourceCommit)
    expect(manifest.baseTargetCommit).toBe(f.targetCommit)
    expect(manifest.files).toHaveLength(initialPlan.files.length)

    await git(f.targetRoot, "add", ".")
    await git(f.targetRoot, "commit", "-m", "mirror private source")
    const mirroredTargetCommit = await git(f.targetRoot, "rev-parse", "HEAD")
    await writeFile(join(f.sourceRoot, "README.md"), sourceReadme)

    const nextPlan = await createMirrorPlan({
      sourceRoot: f.sourceRoot,
      sourceCommit: f.sourceCommit,
      targetRoot: f.targetRoot,
      targetCommit: mirroredTargetCommit,
    })
    expect(nextPlan.summary.added).toStrictEqual([])
    expect(nextPlan.summary.updated).toStrictEqual([])
    expect(nextPlan.summary.removed).toStrictEqual([])
    expect(nextPlan.summary.unchanged).toHaveLength(initialPlan.files.length)

    const readmePath = join(f.targetRoot, "README.md")
    await writeFile(readmePath, "unapproved target race\n")
    await expect(applyMirrorPlan(nextPlan)).rejects.toThrow(
      "Target checkout is not clean"
    )
    await writeFile(readmePath, sourceReadme)

    const tamperedPlan = {
      ...nextPlan,
      files: nextPlan.files.map((file, index) =>
        index === 0 ? { ...file, content: Buffer.from("tampered") } : file
      ),
    }
    await expect(applyMirrorPlan(tamperedPlan)).rejects.toThrow(
      "content or digest is invalid"
    )
    await expect(
      applyMirrorPlan({ ...nextPlan, sourceCommit: "not-a-commit" })
    ).rejects.toThrow("source commit is invalid")
    await expect(
      applyMirrorPlan({ ...nextPlan, files: [...nextPlan.files].reverse() })
    ).rejects.toThrow("canonical order")

    await git(f.targetRoot, "commit", "--allow-empty", "-m", "target race")
    await expect(applyMirrorPlan(nextPlan)).rejects.toThrow(
      "HEAD does not match"
    )
  }, 30_000)

  // 回归：此前所有 apply 测试都只覆盖 bootstrap（目标空树，git status 全是
  // "??" 无前导空格），增量 apply 的正向路径一次都没测过。而 verifyAppliedTree
  // 用经过 trim 的 status 逐行 slice(3)，会吃掉第一行的前导空格；manifest 以
  // "." 开头必然排首行且增量时必为 " M"，于是每次增量 apply 都被误判为非法
  // worktree 变更。这条测试固定"增量 apply 必须成功"。
  it("applies an incremental mirror update on top of a committed mirror", async () => {
    const f = await fixture()
    const initialPlan = await createMirrorPlan({
      sourceRoot: f.sourceRoot,
      sourceCommit: f.sourceCommit,
      targetRoot: f.targetRoot,
      targetCommit: f.targetCommit,
    })
    await applyMirrorPlan(initialPlan)
    await git(f.targetRoot, "add", "-A")
    await git(f.targetRoot, "commit", "-m", "bootstrap mirror")
    const mirroredCommit = await git(f.targetRoot, "rev-parse", "HEAD")

    const updatedReadme = "# incremental mirror update\n"
    await writeFile(join(f.sourceRoot, "README.md"), updatedReadme)
    await git(f.privateRepository, "add", "cli")
    await git(f.privateRepository, "commit", "-m", "update readme")
    const nextSourceCommit = await git(f.privateRepository, "rev-parse", "HEAD")

    const incrementalPlan = await createMirrorPlan({
      sourceRoot: f.sourceRoot,
      sourceCommit: nextSourceCommit,
      targetRoot: f.targetRoot,
      targetCommit: mirroredCommit,
    })
    expect(incrementalPlan.summary.updated).toContain("README.md")

    // 修复前这里抛 "Mirror apply produced an unexpected worktree change"。
    await expect(applyMirrorPlan(incrementalPlan)).resolves.toBeUndefined()

    expect(await readFile(join(f.targetRoot, "README.md"), "utf8")).toBe(
      updatedReadme
    )
    const manifest = JSON.parse(
      await readFile(join(f.targetRoot, ".adrate-public-mirror.json"), "utf8")
    ) as { sourceCommit: string; baseTargetCommit: string }
    expect(manifest.sourceCommit).toBe(nextSourceCommit)
    expect(manifest.baseTargetCommit).toBe(mirroredCommit)
  }, 30_000)

  it("requires the exact production GitHub origin", async () => {
    const f = await fixture()
    await git(
      f.targetRoot,
      "remote",
      "set-url",
      "origin",
      "https://github.com/AdRate-io/cli"
    )
    await expect(
      createMirrorPlan({
        sourceRoot: f.sourceRoot,
        sourceCommit: f.sourceCommit,
        targetRoot: f.targetRoot,
        targetCommit: f.targetCommit,
      })
    ).resolves.toMatchObject({ sourceCommit: f.sourceCommit })

    for (const remote of [
      "https://github.com:443/AdRate-io/cli",
      "https://user@github.com/AdRate-io/cli.git",
      "https://github.com/AdRate-io/cli.git?ref=main",
      "https://github.com/AdRate-io/cli.git#main",
      "https://github.com/AdRate-io/cli/extra",
      "https://github.com/AdRate-io/cli.git/",
      "https://github.com/AdRate-io/cli-lookalike.git",
      "https://github.example/AdRate-io/cli.git",
      "git@github.com:AdRate-io/cli.git",
      "ssh://git@github.com/AdRate-io/cli.git",
      "https://github.com/attacker/cli.git",
    ]) {
      await git(f.targetRoot, "remote", "set-url", "origin", remote)
      await expect(
        createMirrorPlan({
          sourceRoot: f.sourceRoot,
          sourceCommit: f.sourceCommit,
          targetRoot: f.targetRoot,
          targetCommit: f.targetCommit,
        })
      ).rejects.toThrow("origin does not exactly match")
    }
  }, 30_000)

  it("rejects executable Git blobs even when their path is allowlisted", async () => {
    const f = await fixture()
    await chmod(join(f.sourceRoot, "src/bin.ts"), 0o755)
    await git(f.privateRepository, "add", "cli/src/bin.ts")
    await git(f.privateRepository, "commit", "-m", "make source executable")
    const executableCommit = await git(f.privateRepository, "rev-parse", "HEAD")

    await expect(
      createMirrorPlan({
        sourceRoot: f.sourceRoot,
        sourceCommit: executableCommit,
        targetRoot: f.targetRoot,
        targetCommit: f.targetCommit,
      })
    ).rejects.toThrow("unsupported Git object")
  })

  it("rejects a source-history rollback after a newer private commit was mirrored", async () => {
    const f = await fixture()
    const oldSourceCommit = f.sourceCommit
    await writeFile(join(f.sourceRoot, "README.md"), "newer approved source\n")
    await git(f.privateRepository, "add", "cli/README.md")
    await git(f.privateRepository, "commit", "-m", "newer source")
    const newerSourceCommit = await git(
      f.privateRepository,
      "rev-parse",
      "HEAD"
    )
    const plan = await createMirrorPlan({
      sourceRoot: f.sourceRoot,
      sourceCommit: newerSourceCommit,
      targetRoot: f.targetRoot,
      targetCommit: f.targetCommit,
    })
    await applyMirrorPlan(plan)
    await git(f.targetRoot, "add", ".")
    await git(f.targetRoot, "commit", "-m", "mirror newer source")
    const mirroredCommit = await git(f.targetRoot, "rev-parse", "HEAD")

    await git(f.privateRepository, "checkout", "--detach", oldSourceCommit)
    await expect(
      createMirrorPlan({
        sourceRoot: f.sourceRoot,
        sourceCommit: oldSourceCommit,
        targetRoot: f.targetRoot,
        targetCommit: mirroredCommit,
      })
    ).rejects.toThrow("roll back the public source history")
  }, 30_000)

  it("does not follow a target parent symlink race or mutate the target index", async () => {
    const f = await fixture()
    const plan = await createMirrorPlan({
      sourceRoot: f.sourceRoot,
      sourceCommit: f.sourceCommit,
      targetRoot: f.targetRoot,
      targetCommit: f.targetCommit,
    })
    const outside = join(f.root, "outside")
    await mkdir(outside)
    await writeFile(join(outside, "sentinel"), "outside remains untouched\n")
    const indexBefore = await git(f.targetRoot, "write-tree")

    await expect(
      applyMirrorPlan(plan, {
        testHooks: {
          beforeTargetPatchApply: async () => {
            await symlink(outside, join(f.targetRoot, ".github"), "dir")
          },
        },
      })
    ).rejects.toThrow()
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe(
      "outside remains untouched\n"
    )
    expect(await readdir(outside)).toStrictEqual(["sentinel"])
    expect(await git(f.targetRoot, "write-tree")).toBe(indexBefore)
  }, 30_000)

  it.skipIf(process.env.ADRATE_SKIP_PUBLIC_MIRROR_E2E === "1")(
    "produces a commit-closed public mirror that passes the full public-root gate",
    async () => {
      const f = await fixture()
      const plan = await createMirrorPlan({
        sourceRoot: f.sourceRoot,
        sourceCommit: f.sourceCommit,
        targetRoot: f.targetRoot,
        targetCommit: f.targetCommit,
      })
      await applyMirrorPlan(plan)
      await git(f.targetRoot, "add", ".")
      await git(f.targetRoot, "commit", "-m", "mirror release candidate")
      const releaseCommit = await git(f.targetRoot, "rev-parse", "HEAD")
      await git(f.targetRoot, "tag", RELEASE_TAG)
      await writeFile(
        join(f.targetRoot, ".git/info/exclude"),
        "\nnode_modules\n",
        {
          flag: "a",
        }
      )
      await symlink(
        await realpath(join(CLI_ROOT, "node_modules")),
        join(f.targetRoot, "node_modules"),
        process.platform === "win32" ? "junction" : "dir"
      )
      const publicEnvironment = {
        ...process.env,
        ADRATE_SKIP_PUBLIC_MIRROR_E2E: "1",
        ADRATE_NO_SKILLS_NOTIFIER: "1",
        ADRATE_NO_UPDATE_NOTIFIER: "1",
      }
      for (const [command, args] of [
        ["pnpm", ["typecheck"]],
        ["pnpm", ["test"]],
        ["pnpm", ["build"]],
      ] as const) {
        await expect(
          execFileAsync(command, [...args], {
            cwd: f.targetRoot,
            encoding: "utf8",
            env: publicEnvironment,
            maxBuffer: 16 * 1024 * 1024,
          })
        ).resolves.toMatchObject({ stderr: expect.any(String) })
      }
      const artifactDirectory = join(await realpath(f.root), "release-artifact")
      const localGate = await execFileAsync(
        process.execPath,
        [
          "scripts/release-gate.mjs",
          "--local",
          "--require-clean",
          "--tag",
          RELEASE_TAG,
          "--commit",
          releaseCommit,
          "--channel",
          RELEASE_CHANNEL,
          "--artifact-dir",
          artifactDirectory,
        ],
        {
          cwd: f.targetRoot,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
        }
      )
      expect(localGate.stdout).toBe("Local release gate PASS\n")
      expect(localGate.stderr).toBe("")
      expect((await readdir(artifactDirectory)).sort()).toStrictEqual([
        `adrate-cli-${CLI_VERSION}.tgz`,
        "release-artifact.json",
      ])

      // 回归：产物清单的顺序必须与外部闸门的 EXPECTED_TARBALL_FILES 逐位
      // 置相同（后者是按完整路径的默认 .sort()）。此前写清单用
      // localeCompare、重建比对干脆不排序，三套顺序互不相同，导致外部闸门
      // 永远拒收本地闸门刚产出的合法产物；而"本地产出 → 外部消费"这条串联
      // 路径从未被端到端跑过，所以一直没暴露。
      const artifactManifest = JSON.parse(
        await readFile(join(artifactDirectory, "release-artifact.json"), "utf8")
      ) as { files: Array<{ path: string }> }
      expect(artifactManifest.files.map((file) => file.path)).toStrictEqual(
        [
          "LICENSE",
          "README.md",
          "dist/bin.d.ts",
          "dist/bin.js",
          "dist/bin.js.map",
          "package.json",
          "scripts/keychain-smoke.mjs",
          "skills/adrate-ads/SKILL.md",
          "skills/adrate-ads/agents/openai.yaml",
          "skills/adrate-ads/skill-manifest.json",
          "skills/adrate-shared/SKILL.md",
          "skills/adrate-shared/agents/openai.yaml",
          "skills/adrate-shared/skill-manifest.json",
          "skills-content/adrate-ads/SKILL.md",
          "skills-content/adrate-shared/SKILL.md",
        ].sort()
      )
      await expect(collectMirrorSource(f.targetRoot)).resolves.toHaveLength(
        plan.files.length
      )

      const manifestPath = join(f.targetRoot, ".adrate-public-mirror.json")
      const manifest = await readFile(manifestPath)
      await writeFile(
        manifestPath,
        Buffer.concat([manifest, Buffer.from("\n")])
      )
      await expect(
        execFileAsync(
          process.execPath,
          ["scripts/release-gate.mjs", "--local"],
          {
            cwd: f.targetRoot,
            encoding: "utf8",
            maxBuffer: 8 * 1024 * 1024,
          }
        )
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("Public mirror checkout is not clean"),
      })
      await writeFile(manifestPath, manifest)

      await git(f.targetRoot, "commit", "--allow-empty", "-m", "unrelated head")
      await expect(
        execFileAsync(
          process.execPath,
          ["scripts/release-gate.mjs", "--local"],
          {
            cwd: f.targetRoot,
            encoding: "utf8",
            maxBuffer: 8 * 1024 * 1024,
          }
        )
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "not the direct child of its recorded base commit"
        ),
      })
    },
    180_000
  )
})
