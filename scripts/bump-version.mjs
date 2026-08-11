#!/usr/bin/env node

/**
 * 发布版本号一键更新脚本。
 *
 * 版本引用分三层，按"什么时候才需要动"划分：
 *   层 1（每次发布必动）  : cli/package.json version
 *   层 2（Skill 正文变更时）: --skill <版本> 触发
 *     - skills/<name>/SKILL.md 壳 frontmatter（metadata.version → 新 Skill 版本、
 *       minCliVersion → 新 CLI 版本）+ 壳正文升级指引里的 CLI 版本
 *     - test/ 下的 Skill 版本字面量（守门测试故意硬编码，脚本改完后 diff 可见，
 *       守门语义不丢）；patch+1 探针（如 1.5.1）同步推进
 *     - test/ 下的旧 CLI 版本字面量（BUNDLED_SKILL_MIN_CLI_VERSION）
 *     - 自动执行 skills:reseal + validate-skill-assets
 *   层 3（要推给 Accio 平台时）: --accio 触发
 *     - plugins/accio/clis/clis.json 与 connectors/connectors.json 的包 pin
 *
 * 用法（在 cli/ 目录）：
 *   pnpm release:bump <新CLI版本>                       # 仅层 1
 *   pnpm release:bump <新CLI版本> --skill <新Skill版本>  # 层 1 + 2
 *   pnpm release:bump <新CLI版本> --accio               # 层 1 + 3
 *   pnpm release:bump <新CLI版本> --skill <版本> --accio # 全量
 *
 * 任何一处预期替换数为 0 都会失败退出，防止静默漏改。
 * 改完后仍需运行 `npx vitest run` 与根目录 `pnpm accio:check` 验证。
 */

import { execFileSync } from "node:child_process"
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const CLI_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = dirname(CLI_ROOT)
const SKILL_NAMES = ["adrate-shared", "adrate-ads"]
const ACCIO_PIN_FILES = [
  join(REPO_ROOT, "plugins", "accio", "clis", "clis.json"),
  join(REPO_ROOT, "plugins", "accio", "connectors", "connectors.json"),
]

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function fail(message) {
  process.stderr.write(`bump-version failed: ${message}\n`)
  process.exit(1)
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** 全局替换并返回次数；expectAtLeastOne 时零替换视为漏改，直接失败 */
function replaceInFile(path, from, to, { expectAtLeastOne = true } = {}) {
  const before = readFileSync(path, "utf8")
  const matches = before.match(new RegExp(escapeRegExp(from), "g"))
  const count = matches ? matches.length : 0
  if (count === 0) {
    if (expectAtLeastOne) {
      fail(`expected "${from}" in ${relative(REPO_ROOT, path)}, found none`)
    }
    return 0
  }
  writeFileSync(path, before.split(from).join(to))
  return count
}

function bumpPatch(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) fail(`skill version must be plain semver (x.y.z), got "${version}"`)
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

function readShellFrontmatter(name) {
  const path = join(CLI_ROOT, "skills", name, "SKILL.md")
  const text = readFileSync(path, "utf8")
  const version = text.match(/^\s{2}version: "([^"]+)"$/m)?.[1]
  const minCliVersion = text.match(/^\s{2}minCliVersion: "([^"]+)"$/m)?.[1]
  if (!version || !minCliVersion) fail(`cannot parse frontmatter of ${path}`)
  return { path, version, minCliVersion }
}

function listTestFiles() {
  return readdirSync(join(CLI_ROOT, "test"))
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => join(CLI_ROOT, "test", entry))
}

// ---------- 解析参数 ----------

const args = process.argv.slice(2)
const positional = []
let newSkillVersion = null
let updateAccio = false
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--skill") {
    newSkillVersion = args[i + 1] ?? fail("--skill requires a version")
    i += 1
  } else if (args[i] === "--accio") {
    updateAccio = true
  } else {
    positional.push(args[i])
  }
}
const newCliVersion = positional[0]
if (!newCliVersion) fail("usage: pnpm release:bump <new-cli-version> [--skill <new-skill-version>] [--accio]")
if (!VERSION_PATTERN.test(newCliVersion)) fail(`invalid CLI version "${newCliVersion}"`)
if (newSkillVersion && !VERSION_PATTERN.test(newSkillVersion)) fail(`invalid skill version "${newSkillVersion}"`)

const packageJsonPath = join(CLI_ROOT, "package.json")
const oldCliVersion = JSON.parse(readFileSync(packageJsonPath, "utf8")).version
if (oldCliVersion === newCliVersion) fail(`CLI version is already ${newCliVersion}`)

const changes = []

// ---------- 层 1：package.json ----------

replaceInFile(packageJsonPath, `"version": "${oldCliVersion}"`, `"version": "${newCliVersion}"`)
changes.push(`cli/package.json: ${oldCliVersion} -> ${newCliVersion}`)

// ---------- 层 2：Skill 版本链 ----------

if (newSkillVersion) {
  const shells = SKILL_NAMES.map(readShellFrontmatter)
  const oldSkillVersion = shells[0].version
  if (shells.some((shell) => shell.version !== oldSkillVersion)) {
    fail(`skill versions are not in lockstep: ${shells.map((s) => s.version).join(" / ")}`)
  }
  if (oldSkillVersion === newSkillVersion) fail(`skill version is already ${newSkillVersion}`)

  for (const shell of shells) {
    // frontmatter 的 metadata.version + minCliVersion + 正文升级指引，一并替换
    const versionCount = replaceInFile(shell.path, `"${oldSkillVersion}"`, `"${newSkillVersion}"`)
    const cliCount = replaceInFile(shell.path, shell.minCliVersion, newCliVersion)
    changes.push(`${relative(REPO_ROOT, shell.path)}: skill x${versionCount}, minCliVersion x${cliCount}`)
  }

  const oldProbe = bumpPatch(oldSkillVersion)
  const newProbe = bumpPatch(newSkillVersion)
  // CLI 连发多版而 Skill 未变时，测试里镜像的是滞后的 minCliVersion 而非上一个 CLI 版本，两者都要替换
  const oldCliLiterals = [...new Set([oldCliVersion, shells[0].minCliVersion])]
  for (const path of listTestFiles()) {
    let count = 0
    count += replaceInFile(path, oldSkillVersion, newSkillVersion, { expectAtLeastOne: false })
    count += replaceInFile(path, oldProbe, newProbe, { expectAtLeastOne: false })
    for (const literal of oldCliLiterals) {
      count += replaceInFile(path, literal, newCliVersion, { expectAtLeastOne: false })
    }
    if (count > 0) changes.push(`${relative(REPO_ROOT, path)}: x${count}`)
  }

  execFileSync("node", [join(CLI_ROOT, "scripts", "reseal-skill-assets.mjs")], { stdio: "inherit" })
  execFileSync("node", [join(CLI_ROOT, "scripts", "validate-skill-assets.mjs")], { stdio: "inherit" })
  changes.push("skill manifests: resealed + validated")
}

// ---------- 层 3：Accio pin ----------

if (updateAccio) {
  for (const path of ACCIO_PIN_FILES) {
    const count = replaceInFile(path, oldCliVersion, newCliVersion)
    changes.push(`${relative(REPO_ROOT, path)}: x${count}`)
  }
}

// ---------- 汇总 ----------

process.stdout.write("\nDone. Changed:\n")
for (const line of changes) process.stdout.write(`  ${line}\n`)
process.stdout.write(
  "\nNext: review the diff, then run `npx vitest run` (cli/) and `pnpm accio:check` (repo root).\n"
)
if (!updateAccio) {
  process.stdout.write("Note: Accio pins were NOT updated (pass --accio when pushing to the Accio platform).\n")
}
