#!/usr/bin/env node

import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { constants as fsConstants } from "node:fs"
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { collectReleaseSource } from "./public-mirror.mjs"
import {
  SECRET_CONTENT_PATTERNS,
  SECRET_FILE_PATTERN,
} from "./secret-patterns.mjs"

const execFileAsync = promisify(execFile)
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const CLI_ROOT = resolve(dirname(SCRIPT_PATH), "..")
const EXPECTED_REPOSITORY = "git+https://github.com/AdRate-io/cli.git"
const EXPECTED_PACKAGE_MANAGER = "pnpm@10.18.0"
const RELEASE_ARTIFACT_MANIFEST = "release-artifact.json"
const SHA1_PATTERN = /^[0-9a-f]{40}$/
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/
export const EXPECTED_TARBALL_FILES = Object.freeze(
  [
    "LICENSE",
    "README.md",
    "README.zh-CN.md",
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
const INSTALL_COMMANDS = Object.freeze([
  "npm install -g @adrate/cli",
  "adrate skills install",
])

function fail(message) {
  throw new Error(message)
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex")
}

function toPosix(path) {
  return path.split(sep).join("/")
}

function assertNoSecret(path, content) {
  if (SECRET_FILE_PATTERN.test(path)) {
    fail(`Secret scan rejected a sensitive filename: ${path}`)
  }
  if (content.includes(0)) fail(`Secret scan rejected a binary file: ${path}`)
  const text = content.toString("utf8")
  if (SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(text))) {
    fail(`Secret scan rejected a credential-shaped value in: ${path}`)
  }
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    fail(`${label} is not valid JSON.`)
  }
}

async function gitAt(root, args) {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout.trim()
}

function parseSemver(value) {
  if (typeof value !== "string") return null
  const match = SEMVER_PATTERN.exec(value)
  if (!match) return null
  return {
    core: [match[1], match[2], match[3]],
    prerelease: match[4]?.split(".") ?? null,
  }
}

export function releaseChannelForVersion(version) {
  const parsed = parseSemver(version)
  if (!parsed) fail("package.json version is not strict SemVer.")
  return parsed.prerelease === null ? "stable" : "prerelease"
}

function distTagForChannel(channel) {
  if (channel === "prerelease") return "next"
  if (channel === "stable") return "latest"
  fail("Release channel must be prerelease or stable.")
}

export function validateReleaseIdentity(identity) {
  const channel = releaseChannelForVersion(identity.version)
  if (identity.channel !== channel) {
    fail("Release channel does not match the package version.")
  }
  if (identity.tag !== `v${identity.version}`) {
    fail("Git tag does not exactly match package.json version.")
  }
  if (!SHA1_PATTERN.test(identity.commit)) {
    fail("Release commit must be a full lowercase Git SHA.")
  }
  return {
    ...identity,
    channel,
    distTag: distTagForChannel(channel),
  }
}

export async function assertReleaseGitIdentity(root, identity) {
  const validated = validateReleaseIdentity(identity)
  const topLevel = await realpath(
    await gitAt(root, ["rev-parse", "--show-toplevel"])
  )
  const expectedRoot = await realpath(root)
  if (topLevel !== expectedRoot) {
    fail("Release identity must be checked at the public repository root.")
  }
  const head = await gitAt(root, ["rev-parse", "HEAD"])
  if (head !== validated.commit) fail("GITHUB_SHA does not match release HEAD.")
  let taggedCommit
  try {
    taggedCommit = await gitAt(root, [
      "rev-parse",
      `refs/tags/${validated.tag}^{commit}`,
    ])
  } catch {
    fail("Release tag does not resolve to a commit in this checkout.")
  }
  if (taggedCommit !== head) {
    fail("Release tag does not dereference to release HEAD.")
  }
  return validated
}

function assertPackageMetadata(packageJson) {
  if (
    packageJson.name !== "@adrate/cli" ||
    !parseSemver(packageJson.version) ||
    packageJson.repository?.type !== "git" ||
    packageJson.repository?.url !== EXPECTED_REPOSITORY ||
    packageJson.packageManager !== EXPECTED_PACKAGE_MANAGER ||
    packageJson.publishConfig?.access !== "public" ||
    JSON.stringify(packageJson.bin) !==
      JSON.stringify({ adrate: "./dist/bin.js" }) ||
    JSON.stringify(packageJson.exports) !== "{}" ||
    JSON.stringify(packageJson.files) !==
      JSON.stringify([
        "LICENSE",
        "dist",
        "skills",
        "skills-content",
        "README.md",
        "README.zh-CN.md",
        "scripts/keychain-smoke.mjs",
      ])
  ) {
    fail("package.json does not match the frozen public package contract.")
  }
}

async function assertCleanCheckout() {
  const status = await gitAt(CLI_ROOT, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ".",
  ])
  if (status.length > 0) fail("Release checkout is not clean.")
}

async function scanTrackedFiles() {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", CLI_ROOT, "ls-files", "-z", "--", "."],
    { encoding: "utf8" }
  )
  for (const path of stdout.split("\0").filter(Boolean)) {
    if (SECRET_FILE_PATTERN.test(path)) {
      fail(`Tracked source contains a sensitive filename: ${path}`)
    }
    const info = await lstat(resolve(CLI_ROOT, path))
    if (info.isSymbolicLink() || !info.isFile()) {
      fail(`Tracked source contains an unsupported file type: ${path}`)
    }
    assertNoSecret(path, await readFile(resolve(CLI_ROOT, path)))
  }
}

function assertSnapshotPath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail("Release snapshot path escaped its root.")
  }
}

async function materializeSnapshot(destination, sourceFiles) {
  await mkdir(destination)
  for (const file of sourceFiles) {
    assertSnapshotPath(file.path)
    const target = resolve(destination, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content, { flag: "wx" })
  }
  const nodeModules = await realpath(resolve(CLI_ROOT, "node_modules"))
  await symlink(
    nodeModules,
    resolve(destination, "node_modules"),
    process.platform === "win32" ? "junction" : "dir"
  )
}

async function pack(snapshotRoot, destination) {
  const npmCache = resolve(destination, ".npm-cache")
  await mkdir(npmCache)
  await execFileAsync("pnpm", ["run", "build"], {
    cwd: snapshotRoot,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    maxBuffer: 4 * 1024 * 1024,
  })
  await rm(resolve(snapshotRoot, "node_modules"))
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
    {
      cwd: snapshotRoot,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: npmCache },
      maxBuffer: 4 * 1024 * 1024,
    }
  )
  let result
  try {
    result = JSON.parse(stdout)
  } catch {
    fail("npm pack did not return JSON metadata.")
  }
  const filename = result?.[0]?.filename
  if (
    typeof filename !== "string" ||
    !/^adrate-cli-[0-9A-Za-z.-]+\.tgz$/.test(filename)
  ) {
    fail("npm pack returned an unsafe tarball filename.")
  }
  return resolve(destination, filename)
}

async function tarballEntries(tarball) {
  const { stdout } = await execFileAsync("tar", ["-tzf", tarball], {
    encoding: "utf8",
  })
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((path) => path.replace(/^package\//, ""))
    .sort()
}

/**
 * 包内路径的唯一排序口径：按完整路径做 UTF-16 码位比较。
 *
 * 必须与 EXPECTED_TARBALL_FILES 的默认 `.sort()` 完全一致，否则外部闸门
 * 会拒收本地闸门刚产出的合法产物。不能用 localeCompare：它的结果依赖运行
 * 环境 locale（本地能过、CI 过不了），且 "skills-content/..." 与
 * "skills/..." 在两种口径下相对顺序相反（'-'=45 < '/'=47，但按目录逐层
 * 排序时 "skills" 作为更短前缀反而在前）。
 */
function comparePackagePath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

async function extractAndHash(tarball, destination) {
  await mkdir(destination, { recursive: true })
  await execFileAsync("tar", ["-xzf", tarball, "-C", destination])
  const packageRoot = resolve(destination, "package")
  const collected = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => comparePackagePath(left.name, right.name))
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        fail("Tarball contains an unsupported file type.")
      }
      if (entry.isDirectory()) await visit(path)
      else {
        const relativePath = toPosix(relative(packageRoot, path))
        const content = await readFile(path)
        assertNoSecret(relativePath, content)
        collected.push([relativePath, sha256(content)])
      }
    }
  }
  await visit(packageRoot)
  collected.sort(([left], [right]) => comparePackagePath(left, right))
  return { packageRoot, hashes: new Map(collected) }
}

async function assertPackedPackage(packageRoot, expectedVersion) {
  const packageJson = await readJson(
    resolve(packageRoot, "package.json"),
    "packed package.json"
  )
  assertPackageMetadata(packageJson)
  if (packageJson.version !== expectedVersion)
    fail("Packed package version drifted.")
  const sourceMap = await readJson(
    resolve(packageRoot, "dist/bin.js.map"),
    "dist/bin.js.map"
  )
  if (
    Object.hasOwn(sourceMap, "sourcesContent") ||
    !Array.isArray(sourceMap.sources)
  ) {
    fail("Published source map must omit sourcesContent.")
  }
  const dependencyLink = resolve(packageRoot, "node_modules")
  await symlink(
    await realpath(resolve(CLI_ROOT, "node_modules")),
    dependencyLink,
    process.platform === "win32" ? "junction" : "dir"
  )
  let help
  try {
    help = await execFileAsync(
      process.execPath,
      [resolve(packageRoot, "dist/bin.js"), "--help"],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          ADRATE_NO_SKILLS_NOTIFIER: "1",
        },
      }
    )
  } finally {
    await rm(dependencyLink)
  }
  const rendered = `${help.stdout}${help.stderr}`
  for (const command of INSTALL_COMMANDS) {
    if (!rendered.includes(command)) {
      fail(`Packed CLI help is missing the installation command: ${command}`)
    }
  }
}

function assertArtifactDirectoryTarget(path) {
  if (!isAbsolute(path)) fail("Release artifact directory must be absolute.")
  const target = resolve(path)
  const fromCli = relative(CLI_ROOT, target)
  if (fromCli === "" || (!fromCli.startsWith("..") && !isAbsolute(fromCli))) {
    fail("Release artifact directory must be outside the checkout.")
  }
  return target
}

async function persistReleaseArtifact(
  tarball,
  hashes,
  identity,
  artifactDirectory
) {
  const targetDirectory = assertArtifactDirectoryTarget(artifactDirectory)
  const parent = dirname(targetDirectory)
  if ((await realpath(parent)) !== resolve(parent)) {
    fail("Release artifact parent must not traverse a symlink.")
  }
  await mkdir(targetDirectory, { mode: 0o700 })
  const filename = `adrate-cli-${identity.version}.tgz`
  const targetTarball = resolve(targetDirectory, filename)
  await copyFile(tarball, targetTarball, fsConstants.COPYFILE_EXCL)
  const digest = sha256(await readFile(targetTarball))
  const manifest = {
    formatVersion: 1,
    packageName: "@adrate/cli",
    version: identity.version,
    channel: identity.channel,
    distTag: identity.distTag,
    tag: identity.tag,
    commit: identity.commit,
    tarball: filename,
    sha256: digest,
    files: [...hashes]
      .sort(([left], [right]) => comparePackagePath(left, right))
      .map(([path, fileSha256]) => ({ path, sha256: fileSha256 })),
  }
  await writeFile(
    resolve(targetDirectory, RELEASE_ARTIFACT_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o444, flag: "wx" }
  )
  await chmod(targetTarball, 0o444)
  return { targetDirectory, manifest }
}

async function assertVerifiedPackage(sourceFiles, packageJson, options = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "adrate-release-gate-"))
  try {
    const buildDirectory = resolve(root, "build")
    await mkdir(buildDirectory)
    const snapshot = resolve(buildDirectory, "snapshot")
    await materializeSnapshot(snapshot, sourceFiles)
    const tarball = await pack(snapshot, buildDirectory)
    const entries = await tarballEntries(tarball)
    if (JSON.stringify(entries) !== JSON.stringify(EXPECTED_TARBALL_FILES)) {
      fail("npm tarball does not contain the frozen 15 files.")
    }
    const extracted = await extractAndHash(tarball, resolve(root, "unpack"))
    await assertPackedPackage(extracted.packageRoot, packageJson.version)
    if (options.artifactDirectory) {
      await persistReleaseArtifact(
        tarball,
        extracted.hashes,
        options.identity,
        options.artifactDirectory
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function loadPackageJson() {
  const packageJson = await readJson(
    resolve(CLI_ROOT, "package.json"),
    "package.json"
  )
  assertPackageMetadata(packageJson)
  return packageJson
}

async function releaseIdentityFromOptions(
  packageJson,
  options,
  requireIdentity
) {
  const identityAnchorCount = [options.tag, options.commit].filter(
    Boolean
  ).length
  if (identityAnchorCount === 0 && !requireIdentity) return null
  const provided = [options.tag, options.commit, options.channel].filter(
    Boolean
  ).length
  if (provided !== 3)
    fail("Release tag, commit, and channel must be supplied together.")
  return assertReleaseGitIdentity(CLI_ROOT, {
    version: packageJson.version,
    tag: options.tag,
    commit: options.commit,
    channel: options.channel,
  })
}

async function assertLocalGate(options) {
  const packageJson = await loadPackageJson()
  const identity = await releaseIdentityFromOptions(
    packageJson,
    options,
    Boolean(options.artifactDirectory)
  )
  if (options.requireClean) await assertCleanCheckout()
  await scanTrackedFiles()
  const sourceFiles = await collectReleaseSource(CLI_ROOT, {
    requireCommitted:
      options.requireClean || Boolean(options.artifactDirectory),
  })
  await assertVerifiedPackage(sourceFiles, packageJson, {
    ...(options.artifactDirectory
      ? { artifactDirectory: options.artifactDirectory, identity }
      : {}),
  })
}

function parseArguments(argv) {
  const options = {
    mode: null,
    requireClean: false,
    tag: null,
    commit: null,
    channel: null,
    artifactDirectory: null,
  }
  const modes = new Map([
    ["--local", "local"],
    ["--identity", "identity"],
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (modes.has(argument)) {
      if (options.mode) fail("Choose exactly one release gate mode.")
      options.mode = modes.get(argument)
      continue
    }
    if (argument === "--require-clean") {
      options.requireClean = true
      continue
    }
    const value = argv[index + 1]
    if (!value) fail(`${argument} requires a value.`)
    if (argument === "--tag") options.tag = value
    else if (argument === "--commit") options.commit = value
    else if (argument === "--channel") options.channel = value
    else if (argument === "--artifact-dir") options.artifactDirectory = value
    else fail(`Unknown release gate argument: ${argument}`)
    index += 1
  }
  if (!options.mode) fail("Choose exactly one release gate mode.")
  if (options.requireClean && options.mode !== "local") {
    fail("--require-clean is only valid for the local gate.")
  }
  if (options.artifactDirectory && options.mode !== "local") {
    fail("--artifact-dir is not valid for this release gate mode.")
  }
  return options
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.mode === "local") {
    await assertLocalGate(options)
    process.stdout.write("Local release gate PASS\n")
    return
  }
  const packageJson = await loadPackageJson()
  const identity = await releaseIdentityFromOptions(packageJson, options, true)
  if (options.mode === "identity") {
    process.stdout.write(
      `version=${identity.version}\nchannel=${identity.channel}\ndist-tag=${identity.distTag}\n`
    )
    return
  }
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  main().catch((error) => {
    const message =
      error instanceof Error ? error.message : "Unknown release gate failure."
    process.stderr.write(`Release blocked: ${message}\n`)
    process.exitCode = 1
  })
}
