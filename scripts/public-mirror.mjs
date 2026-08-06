#!/usr/bin/env node

import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
  SECRET_CONTENT_PATTERNS,
  SECRET_FILE_PATTERN,
} from "./secret-patterns.mjs"

const execFileAsync = promisify(execFile)
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const DEFAULT_SOURCE_ROOT = resolve(dirname(SCRIPT_PATH), "..")
const MIRROR_MANIFEST = ".adrate-public-mirror.json"
const SHA_PATTERN = /^[0-9a-f]{40}$/
const SKILL_NAMES = new Set(["adrate-shared", "adrate-ads"])
const ROOT_FILES = new Set([
  ".gitignore",
  "LICENSE",
  "README.md",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "tsup.config.ts",
  "vitest.config.ts",
])
const REQUIRED_FILES = Object.freeze([
  ".github/workflows/publish.yml",
  ".gitignore",
  "LICENSE",
  "README.md",
  "package.json",
  "pnpm-lock.yaml",
  "scripts/public-mirror.mjs",
  "scripts/release-gate.mjs",
  "scripts/secret-patterns.mjs",
  "src/bin.ts",
  "test/package.test.ts",
  "skills/adrate-shared/SKILL.md",
  "skills/adrate-ads/SKILL.md",
  "skills-content/adrate-shared/SKILL.md",
  "skills-content/adrate-ads/SKILL.md",
])

function toPosix(path) {
  return path.split(sep).join("/")
}

function isSafeRelativePath(path) {
  return !(
    path.length === 0 ||
    !/^[A-Za-z0-9._/-]+$/.test(path) ||
    isAbsolute(path) ||
    path === ".." ||
    path.startsWith("../") ||
    path.includes("/../") ||
    path.includes("\\") ||
    path
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  )
}

function assertRelativePath(path) {
  if (!isSafeRelativePath(path)) {
    throw new Error("Mirror path escaped its root.")
  }
}

function isApprovedPublicRemote(remote) {
  return /^https:\/\/github\.com\/AdRate-io\/cli(?:\.git)?$/.test(remote)
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

async function assertDirectory(path, label) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory.`)
  }
  return info
}

/**
 * Public mirror policy is intentionally static. Adding a new directory,
 * extension, Skill, workflow, integration artifact, or release artifact must
 * update this function in the private source first.
 */
export function isAllowedMirrorPath(path) {
  assertRelativePath(path)
  if (ROOT_FILES.has(path)) return true
  if (path === ".github/workflows/publish.yml") return true
  if (/^src\/.+\.ts$/.test(path) || /^test\/.+\.ts$/.test(path)) return true
  if (/^scripts\/.+\.(?:mjs|d\.mts)$/.test(path)) return true
  if (/^release\/[A-Za-z0-9._-]+\.md$/.test(path)) return true
  if (
    path === "integrations/accio/compatibility.md" ||
    path === "integrations/accio/validation.json"
  ) {
    return true
  }
  const skill =
    /^skills\/([^/]+)\/(SKILL\.md|skill-manifest\.json|agents\/openai\.yaml)$/.exec(
      path
    )
  if (skill && SKILL_NAMES.has(skill[1])) return true
  const content = /^skills-content\/([^/]+)\/SKILL\.md$/.exec(path)
  return Boolean(content && SKILL_NAMES.has(content[1]))
}

function assertNoSecret(path, content) {
  if (SECRET_FILE_PATTERN.test(path)) {
    throw new Error(`Mirror policy rejected a sensitive filename: ${path}`)
  }
  if (content.includes(0)) {
    throw new Error(`Mirror policy rejected a binary file: ${path}`)
  }
  const text = content.toString("utf8")
  if (SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error(`Mirror secret scan rejected: ${path}`)
  }
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex")
}

async function walk(root, options = {}) {
  const excludedDirectories = new Set(options.excludedDirectories ?? [])
  const files = []
  async function visit(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        throw new Error(`Mirror policy rejects symbolic links: ${path}`)
      }
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(path))
          await visit(resolve(root, path), path)
        continue
      }
      if (!entry.isFile()) {
        throw new Error(`Mirror policy rejects special files: ${path}`)
      }
      files.push(path)
    }
  }
  await visit(root, "")
  return files
}

export async function collectMirrorSource(sourceRoot) {
  const root = await realpath(sourceRoot)
  let manifestInfo = null
  try {
    manifestInfo = await lstat(resolve(root, MIRROR_MANIFEST))
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  if (manifestInfo) {
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
      throw new Error("Public mirror manifest must be a regular file.")
    }
    return collectValidatedPublicMirrorSource(root)
  }
  return collectPrivateMirrorSource(root)
}

export async function collectReleaseSource(
  sourceRoot,
  options = { requireCommitted: false }
) {
  const root = await realpath(sourceRoot)
  let hasManifest = false
  try {
    const info = await lstat(resolve(root, MIRROR_MANIFEST))
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("Public mirror manifest must be a regular file.")
    }
    hasManifest = true
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  if (hasManifest) return collectValidatedPublicMirrorSource(root)
  if (!options.requireCommitted) return collectPrivateMirrorSource(root)

  const topLevel = await git(root, ["rev-parse", "--show-toplevel"])
  const commit = await git(root, ["rev-parse", "HEAD"])
  const sourcePrefix = toPosix(relative(topLevel, root))
  if (sourcePrefix === "" || sourcePrefix.startsWith("../")) {
    throw new Error(
      "Committed private release source must be a dedicated repository directory."
    )
  }
  const status = await git(topLevel, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    sourcePrefix,
  ])
  if (status.length > 0) {
    throw new Error("Committed release source is not clean.")
  }
  return collectCommittedSource(topLevel, commit, sourcePrefix)
}

async function collectPrivateMirrorSource(root) {
  const paths = await walk(root, {
    excludedDirectories: [".git", "dist", "node_modules"],
  })
  const files = []
  for (const path of paths) {
    if (!isAllowedMirrorPath(path)) {
      throw new Error(
        `Source contains a path outside the mirror allowlist: ${path}`
      )
    }
    const content = await readFile(resolve(root, path))
    assertNoSecret(path, content)
    files.push({ path, sha256: sha256(content), content })
  }
  const found = new Set(files.map((file) => file.path))
  for (const required of REQUIRED_FILES) {
    if (!found.has(required)) {
      throw new Error(`Mirror source is missing required file: ${required}`)
    }
  }
  return files
}

async function git(repoRoot, args) {
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
  })
  return stdout.trim()
}

async function gitObject(repoRoot, object) {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repoRoot, "cat-file", "blob", object],
    {
      encoding: null,
      maxBuffer: 16 * 1024 * 1024,
    }
  )
  return stdout
}

async function isAncestor(repoRoot, ancestor, descendant) {
  try {
    await execFileAsync(
      "git",
      ["-C", repoRoot, "merge-base", "--is-ancestor", ancestor, descendant],
      { encoding: "utf8" }
    )
    return true
  } catch (error) {
    if (error?.code === 1) return false
    throw error
  }
}

async function assertGitCheckout(path, expectedCommit, label) {
  if (!SHA_PATTERN.test(expectedCommit)) {
    throw new Error(`${label} commit must be a full lowercase Git SHA.`)
  }
  const root = await realpath(path)
  const topLevel = await git(root, ["rev-parse", "--show-toplevel"])
  const commit = await git(root, ["rev-parse", "HEAD"])
  if (commit !== expectedCommit) {
    throw new Error(
      `${label} HEAD does not match the explicitly approved commit.`
    )
  }
  const status = await git(topLevel, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ])
  if (status.length > 0) {
    throw new Error(`${label} checkout is not clean.`)
  }
  return { root, topLevel, commit }
}

function parsePriorManifest(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.formatVersion !== 1 ||
    !SHA_PATTERN.test(value.sourceCommit) ||
    !SHA_PATTERN.test(value.baseTargetCommit) ||
    !Array.isArray(value.files) ||
    Object.keys(value).sort().join(",") !==
      "baseTargetCommit,files,formatVersion,sourceCommit"
  ) {
    return null
  }
  const files = []
  const seen = new Set()
  for (const entry of value.files) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(",") !== "path,sha256" ||
      typeof entry.path !== "string" ||
      !isSafeRelativePath(entry.path) ||
      !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      seen.has(entry.path)
    ) {
      return null
    }
    seen.add(entry.path)
    files.push({ path: entry.path, sha256: entry.sha256 })
  }
  if (
    JSON.stringify(files.map((file) => file.path)) !==
    JSON.stringify(
      files
        .map((file) => file.path)
        .sort((left, right) => left.localeCompare(right))
    )
  ) {
    return null
  }
  // 刻意不在这里校验 REQUIRED_FILES。prior manifest 是**历史**状态，用**当前**
  // 的必需文件清单去要求它会造成死锁：任何一次往 REQUIRED_FILES 新增文件，都会
  // 让写于该文件存在之前的 manifest 立刻变成 "invalid"，此后每一次镜像同步都被
  // 拒绝，且错误信息完全指不到根因（2026-08-03 加 LICENSE 与 secret-patterns.mjs
  // 时实际触发）。REQUIRED_FILES 的正确执行点是 source 侧的 collectCommittedSource
  // ——它保证**即将写出**的镜像状态是完整的；prior manifest 只负责建立可信基线，
  // 供计划计算最小 diff 与单父闭合校验。apply 之后 target 内容等于 source，
  // 完整性由 source 侧那道检查兜住，这里放宽不会让缺文件的终态通过。
  return { ...value, files }
}

async function committedTreeEntries(repositoryRoot, commit, sourcePrefix) {
  const pathspec = sourcePrefix || "."
  const { stdout } = await execFileAsync(
    "git",
    [
      "-C",
      repositoryRoot,
      "ls-tree",
      "-rz",
      "--full-tree",
      commit,
      "--",
      pathspec,
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
  )
  const prefix = sourcePrefix ? `${sourcePrefix}/` : ""
  const entries = []
  for (const record of stdout.split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t")
    const metadata = record.slice(0, separator).split(" ")
    const repositoryPath = record.slice(separator + 1)
    if (
      separator <= 0 ||
      metadata.length !== 3 ||
      !repositoryPath.startsWith(prefix)
    ) {
      throw new Error("Committed source tree returned malformed metadata.")
    }
    const [mode, type, object] = metadata
    if (
      type !== "blob" ||
      mode !== "100644" ||
      !/^[0-9a-f]{40}$/.test(object)
    ) {
      throw new Error(
        `Committed source tree contains an unsupported Git object: ${repositoryPath}`
      )
    }
    entries.push({
      path: repositoryPath.slice(prefix.length),
      object,
    })
  }
  entries.sort((left, right) => left.path.localeCompare(right.path))
  return entries
}

async function collectCommittedSource(repositoryRoot, commit, sourcePrefix) {
  const entries = await committedTreeEntries(
    repositoryRoot,
    commit,
    sourcePrefix
  )
  const files = []
  for (const entry of entries) {
    if (entry.path === MIRROR_MANIFEST && sourcePrefix === "") continue
    if (!isAllowedMirrorPath(entry.path)) {
      throw new Error(
        `Committed source contains a path outside the mirror allowlist: ${entry.path}`
      )
    }
    const content = await gitObject(repositoryRoot, entry.object)
    assertNoSecret(entry.path, content)
    files.push({ path: entry.path, sha256: sha256(content), content })
  }
  const found = new Set(files.map((file) => file.path))
  for (const required of REQUIRED_FILES) {
    if (!found.has(required)) {
      throw new Error(`Committed source is missing required file: ${required}`)
    }
  }
  return files
}

async function inspectMirrorTarget(targetRoot, targetCommit) {
  const entries = await committedTreeEntries(targetRoot, targetCommit, "")
  const paths = entries.map((entry) => entry.path)
  const hasManifest = paths.includes(MIRROR_MANIFEST)
  if (!hasManifest) {
    if (paths.length > 0) {
      throw new Error("Target has files but no trusted prior mirror manifest.")
    }
    return { files: new Map(), priorManifest: null }
  }
  const manifestEntry = entries.find((entry) => entry.path === MIRROR_MANIFEST)
  const priorManifest = parsePriorManifest(
    (await gitObject(targetRoot, manifestEntry.object)).toString("utf8")
  )
  if (!priorManifest) throw new Error("Target mirror manifest is invalid.")
  const parents = (
    await git(targetRoot, ["show", "-s", "--format=%P", targetCommit])
  )
    .split(" ")
    .filter(Boolean)
  if (parents.length !== 1 || parents[0] !== priorManifest.baseTargetCommit) {
    throw new Error(
      "Target mirror commit is not the direct child of its recorded base commit."
    )
  }
  const manifestCommit = await git(targetRoot, [
    "log",
    "-1",
    "--format=%H",
    "--",
    MIRROR_MANIFEST,
  ])
  if (manifestCommit !== targetCommit) {
    throw new Error(
      "Target mirror manifest was not committed by the approved target HEAD."
    )
  }
  const actualPaths = paths.filter((path) => path !== MIRROR_MANIFEST).sort()
  const expectedPaths = priorManifest.files.map((file) => file.path).sort()
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("Target contains an unrecognized addition or deletion.")
  }
  const files = new Map()
  for (const entry of priorManifest.files) {
    const treeEntry = entries.find((candidate) => candidate.path === entry.path)
    if (!treeEntry) throw new Error("Target mirror tree is missing a file.")
    const content = await gitObject(targetRoot, treeEntry.object)
    assertNoSecret(entry.path, content)
    const digest = sha256(content)
    if (digest !== entry.sha256) {
      throw new Error(
        "Target content differs from its committed mirror manifest."
      )
    }
    files.set(entry.path, digest)
  }
  return { files, priorManifest }
}

async function collectValidatedPublicMirrorSource(root) {
  const topLevel = await git(root, ["rev-parse", "--show-toplevel"])
  if (topLevel !== root) {
    throw new Error("Public mirror source must be the repository root.")
  }
  const commit = await git(root, ["rev-parse", "HEAD"])
  if (!SHA_PATTERN.test(commit)) {
    throw new Error("Public mirror HEAD must be a full lowercase Git SHA.")
  }
  const status = await git(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ])
  if (status.length > 0) {
    throw new Error("Public mirror checkout is not clean.")
  }
  const origin = await git(root, ["remote", "get-url", "origin"])
  if (!isApprovedPublicRemote(origin)) {
    throw new Error("Public mirror origin does not exactly match production.")
  }
  const target = await inspectMirrorTarget(root, commit)
  if (!target.priorManifest) {
    throw new Error("Public mirror checkout is missing its manifest.")
  }
  const files = await collectCommittedSource(root, commit, "")
  if (
    JSON.stringify(
      files.map(({ path, sha256: digest }) => ({ path, sha256: digest }))
    ) !== JSON.stringify(target.priorManifest.files)
  ) {
    throw new Error(
      "Public mirror Git tree differs from its committed manifest."
    )
  }
  return files
}

export async function createMirrorPlan(options) {
  const sourceCheckout = await assertGitCheckout(
    options.sourceRoot,
    options.sourceCommit,
    "Source"
  )
  const sourceRelative = toPosix(
    relative(sourceCheckout.topLevel, sourceCheckout.root)
  )
  if (sourceRelative === "" || sourceRelative.startsWith("../")) {
    throw new Error(
      "Source root must be a dedicated directory inside the private repository."
    )
  }
  const targetCheckout = await assertGitCheckout(
    options.targetRoot,
    options.targetCommit,
    "Target"
  )
  if (targetCheckout.root !== targetCheckout.topLevel) {
    throw new Error("Target root must be the public repository root.")
  }
  const targetOrigin = await git(targetCheckout.root, [
    "remote",
    "get-url",
    "origin",
  ])
  if (!isApprovedPublicRemote(targetOrigin)) {
    throw new Error(
      "Target origin does not exactly match the approved AdRate public repository."
    )
  }
  await options.testHooks?.afterSourceCheckoutValidated?.()
  const sourceFiles = await collectCommittedSource(
    sourceCheckout.topLevel,
    sourceCheckout.commit,
    sourceRelative
  )
  const target = await inspectMirrorTarget(
    targetCheckout.root,
    targetCheckout.commit
  )
  if (
    target.priorManifest &&
    !(await isAncestor(
      sourceCheckout.topLevel,
      target.priorManifest.sourceCommit,
      sourceCheckout.commit
    ))
  ) {
    throw new Error(
      "Mirror source commit would roll back the public source history."
    )
  }
  const sourceByPath = new Map(sourceFiles.map((file) => [file.path, file]))
  const added = []
  const updated = []
  const unchanged = []
  for (const file of sourceFiles) {
    const prior = target.files.get(file.path)
    if (prior === undefined) added.push(file.path)
    else if (prior === file.sha256) unchanged.push(file.path)
    else updated.push(file.path)
  }
  const removed = [...target.files.keys()].filter(
    (path) => !sourceByPath.has(path)
  )
  return {
    sourceRoot: sourceCheckout.root,
    targetRoot: targetCheckout.root,
    sourceCommit: sourceCheckout.commit,
    targetCommit: targetCheckout.commit,
    targetFiles: new Map(target.files),
    files: sourceFiles,
    summary: {
      added: added.sort(),
      updated: updated.sort(),
      removed: removed.sort(),
      unchanged: unchanged.sort(),
    },
  }
}

async function materializeStagedMirror(plan, manifest, stagingRoot) {
  await execFileAsync(
    "git",
    ["clone", "--no-hardlinks", "--quiet", plan.targetRoot, stagingRoot],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
  )
  await git(stagingRoot, ["checkout", "--detach", "--quiet", plan.targetCommit])
  for (const path of plan.summary.removed) {
    await rm(resolve(stagingRoot, path))
  }
  for (const file of plan.files) {
    const target = resolve(stagingRoot, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content, { mode: 0o644 })
  }
  await writeFile(
    resolve(stagingRoot, MIRROR_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644 }
  )
  const paths = (await walk(stagingRoot, { excludedDirectories: [".git"] }))
    .filter((path) => path !== ".git")
    .sort()
  const expectedPaths = [
    ...plan.files.map((file) => file.path),
    MIRROR_MANIFEST,
  ].sort()
  if (JSON.stringify(paths) !== JSON.stringify(expectedPaths)) {
    throw new Error("Staged mirror tree contains an unrecognized path.")
  }
  for (const file of plan.files) {
    if (
      sha256(await readFile(resolve(stagingRoot, file.path))) !== file.sha256
    ) {
      throw new Error(`Staged mirror digest drifted: ${file.path}`)
    }
  }
  await git(stagingRoot, ["add", "-A"])
  const { stdout: patch } = await execFileAsync(
    "git",
    [
      "-C",
      stagingRoot,
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      plan.targetCommit,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  )
  if (patch.length === 0)
    throw new Error("Mirror apply produced an empty patch.")
  return patch
}

async function verifyAppliedTree(plan, manifest, rootIdentity) {
  const currentIdentity = await assertDirectory(
    plan.targetRoot,
    "Mirror target root"
  )
  if (!sameIdentity(rootIdentity, currentIdentity)) {
    throw new Error("Mirror target root identity changed during apply.")
  }
  if (
    (await git(plan.targetRoot, ["rev-parse", "HEAD"])) !== plan.targetCommit
  ) {
    throw new Error("Mirror target HEAD changed during apply.")
  }
  const origin = await git(plan.targetRoot, ["remote", "get-url", "origin"])
  if (!isApprovedPublicRemote(origin)) {
    throw new Error("Mirror target origin changed during apply.")
  }
  const paths = await walk(plan.targetRoot, {
    excludedDirectories: [".git", "dist", "node_modules"],
  })
  const expectedPaths = [
    ...plan.files.map((file) => file.path),
    MIRROR_MANIFEST,
  ].sort()
  if (JSON.stringify(paths.sort()) !== JSON.stringify(expectedPaths)) {
    throw new Error("Applied mirror tree contains an unrecognized path.")
  }
  for (const file of plan.files) {
    if (
      sha256(await readFile(resolve(plan.targetRoot, file.path))) !==
      file.sha256
    ) {
      throw new Error(`Applied mirror digest drifted: ${file.path}`)
    }
  }
  const writtenManifest = parsePriorManifest(
    await readFile(resolve(plan.targetRoot, MIRROR_MANIFEST), "utf8")
  )
  if (
    !writtenManifest ||
    JSON.stringify(writtenManifest) !== JSON.stringify(manifest)
  ) {
    throw new Error("Mirror manifest verification failed after atomic write.")
  }
  const allowedDirty = new Set(expectedPaths)
  for (const removed of plan.summary.removed) allowedDirty.add(removed)
  // 这里必须读未经 trim 的原始 stdout：porcelain v1 的修改行形如 " M path"，
  // 首字符是空格。git() 会 trim 掉整段输出的首尾空白，从而吃掉第一行的前导
  // 空格，使随后的 slice(3) 多切一个字符。由于 manifest 以 "." 开头必然排在
  // 首行、且增量同步时必然是修改态，一旦 trim 就会把它误判成非法路径，导致
  // 每一次增量 apply 都失败（bootstrap 时全是 "??" 无前导空格，故未暴露）。
  const { stdout: status } = await execFileAsync(
    "git",
    [
      "-C",
      plan.targetRoot,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
  )
  for (const line of status.split("\n").filter(Boolean)) {
    const path = line.slice(3)
    if (path.includes(" -> ") || !allowedDirty.has(path)) {
      throw new Error("Mirror apply produced an unexpected worktree change.")
    }
  }
}

export async function applyMirrorPlan(plan, options = {}) {
  if (!SHA_PATTERN.test(plan.sourceCommit)) {
    throw new Error("Mirror plan source commit is invalid.")
  }
  const targetCheckout = await assertGitCheckout(
    plan.targetRoot,
    plan.targetCommit,
    "Target"
  )
  if (targetCheckout.root !== targetCheckout.topLevel) {
    throw new Error("Target root changed after mirror plan creation.")
  }
  const targetOrigin = await git(targetCheckout.root, [
    "remote",
    "get-url",
    "origin",
  ])
  if (!isApprovedPublicRemote(targetOrigin)) {
    throw new Error("Target origin changed after the mirror plan was approved.")
  }
  const currentTarget = await inspectMirrorTarget(
    targetCheckout.root,
    targetCheckout.commit
  )
  if (
    JSON.stringify([...currentTarget.files].sort()) !==
    JSON.stringify([...plan.targetFiles].sort())
  ) {
    throw new Error("Target mirror contents changed after plan creation.")
  }
  const seen = new Set()
  for (const file of plan.files) {
    if (
      typeof file.path !== "string" ||
      !isAllowedMirrorPath(file.path) ||
      seen.has(file.path) ||
      !Buffer.isBuffer(file.content) ||
      sha256(file.content) !== file.sha256
    ) {
      throw new Error("Mirror plan file content or digest is invalid.")
    }
    seen.add(file.path)
  }
  if (
    JSON.stringify(plan.files.map((file) => file.path)) !==
    JSON.stringify(
      plan.files
        .map((file) => file.path)
        .sort((left, right) => left.localeCompare(right))
    )
  ) {
    throw new Error("Mirror plan files are not in canonical order.")
  }
  for (const required of REQUIRED_FILES) {
    if (!seen.has(required)) {
      throw new Error(`Mirror plan is missing required file: ${required}`)
    }
  }
  const expectedRemoved = [...currentTarget.files.keys()]
    .filter((path) => !seen.has(path))
    .sort()
  if (
    JSON.stringify(expectedRemoved) !==
    JSON.stringify([...plan.summary.removed].sort())
  ) {
    throw new Error("Mirror plan removals no longer match the target checkout.")
  }
  const manifest = {
    formatVersion: 1,
    sourceCommit: plan.sourceCommit,
    baseTargetCommit: plan.targetCommit,
    files: plan.files.map(({ path, sha256 }) => ({ path, sha256 })),
  }
  const rootIdentity = await assertDirectory(
    plan.targetRoot,
    "Mirror target root"
  )
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "adrate-mirror-stage-"))
  try {
    const stagingRoot = resolve(temporaryRoot, "checkout")
    const patch = await materializeStagedMirror(plan, manifest, stagingRoot)
    const patchPath = resolve(temporaryRoot, "mirror.patch")
    await writeFile(patchPath, patch, { mode: 0o600, flag: "wx" })
    await execFileAsync(
      "git",
      ["-C", plan.targetRoot, "apply", "--check", "--binary", patchPath],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
    )
    await options.testHooks?.beforeTargetPatchApply?.()
    const identityBeforeApply = await assertDirectory(
      plan.targetRoot,
      "Mirror target root"
    )
    if (!sameIdentity(rootIdentity, identityBeforeApply)) {
      throw new Error("Mirror target root changed before patch apply.")
    }
    await execFileAsync(
      "git",
      [
        "-C",
        plan.targetRoot,
        "apply",
        "--binary",
        "--whitespace=nowarn",
        patchPath,
      ],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
    )
    await verifyAppliedTree(plan, manifest, rootIdentity)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

function parseArguments(argv) {
  const result = {
    sourceRoot: DEFAULT_SOURCE_ROOT,
    targetRoot: null,
    sourceCommit: null,
    targetCommit: null,
    apply: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--apply") {
      result.apply = true
      continue
    }
    const next = argv[index + 1]
    if (!next) throw new Error(`Missing value for ${argument}.`)
    if (argument === "--source-root") result.sourceRoot = resolve(next)
    else if (argument === "--target") result.targetRoot = resolve(next)
    else if (argument === "--source-commit") result.sourceCommit = next
    else if (argument === "--target-commit") result.targetCommit = next
    else throw new Error(`Unknown mirror argument: ${argument}`)
    index += 1
  }
  if (!result.targetRoot || !result.sourceCommit || !result.targetCommit) {
    throw new Error(
      "Usage: public-mirror --target <public-checkout> --source-commit <sha> --target-commit <sha> [--source-root <cli>] [--apply]"
    )
  }
  return result
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const plan = await createMirrorPlan(options)
  if (options.apply) await applyMirrorPlan(plan)
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: options.apply ? "applied" : "dry-run",
        sourceCommit: plan.sourceCommit,
        targetCommit: plan.targetCommit,
        ...plan.summary,
      },
      null,
      2
    )}\n`
  )
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  main().catch((error) => {
    const message =
      error instanceof Error ? error.message : "Unknown mirror failure."
    process.stderr.write(`Public mirror blocked: ${message}\n`)
    process.exitCode = 1
  })
}
