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
const EXPECTED_WORKFLOW_SHA256 =
  "14951c793c12048b916dad9b41dea25cfd881d179644a2923085a5998fdb7d42"
// identity 步骤的完整 argv 属于闭世界合同：release-gate 的 identity 模式要求
// tag/commit/channel 三者同时提供，缺 --channel 必然 exit 1。字节 SHA 已经能拦住
// 任何改动，但只会报"workflow 与已审查字节不一致"，看不出缺了哪一段；这里再单列一条
// 具名子串闸门，让漏传 --channel 这种回归有明确失败原因。
// 注意执行顺序：字节 SHA 校验在前且直接 throw，所以这条**仅在 pin 已被同步更新、
// 但 argv 写错时**才会成为报出的失败原因（正是 R9 那种"重算了 SHA 却漏了 --channel"
// 的场景）。若改了 workflow 而没更新 pin，看到的仍然只有字节 SHA 那条错误。
const EXPECTED_IDENTITY_STEP_COMMAND =
  'node scripts/release-gate.mjs --identity --tag "$GITHUB_REF_NAME" --commit "$GITHUB_SHA" --channel '
const RELEASE_ARTIFACT_MANIFEST = "release-artifact.json"
const REGISTRY_PACKAGE_URL =
  "https://registry.npmjs.org/-/package/@adrate%2Fcli/dist-tags"
const REGISTRY_TIMEOUT_MS = 5_000
const REGISTRY_MAX_BYTES = 64 * 1024
const SHA1_PATTERN = /^[0-9a-f]{40}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/
export const EXPECTED_TARBALL_FILES = Object.freeze(
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
const INSTALL_COMMANDS = Object.freeze([
  "npm install -g @adrate/cli",
  "npx skills add AdRate-io/cli -g -y",
])
const REQUIRED_COMMAND_EXAMPLES = Object.freeze([
  "adrate commands get (--command-id <uuid> | --idempotency-key <key>)",
  "adrate commands pending",
  "adrate commands resume --idempotency-key <key>",
  "adrate skills list",
  "adrate skills read <name> [path]",
])
export const EXTERNAL_GATE_IDS = Object.freeze([
  "github-public-mirror",
  "npm-bootstrap-and-2fa",
  "npm-trusted-publisher",
  "openresty-test",
  "openresty-production",
  "accio-official-connector",
  "real-cli-e2e",
  "windows-hardware",
  "accio-capacity",
])
// M0 不含 Accio connector（Boss 2026-08-02 决策）：官方未公开 custom Connector 的
// manifest schema / device-code 字段 / validator，无法取证，两项 accio gate 从
// required 列表摘除。EXTERNAL_GATE_IDS 九项保持不变——它是 pin 的 exact-nine、
// evidence 路径和镜像 allowlist 的锚点，动它会连锁。两项 gate 条目保留并维持
// blocked，官方补齐合同后转回 required 即可。
export const PRERELEASE_GATE_IDS = Object.freeze([
  "github-public-mirror",
  "npm-bootstrap-and-2fa",
  "npm-trusted-publisher",
  "openresty-test",
])
export const STABLE_GATE_IDS = Object.freeze([
  "github-public-mirror",
  "npm-bootstrap-and-2fa",
  "npm-trusted-publisher",
  "openresty-test",
  "openresty-production",
  "real-cli-e2e",
  "windows-hardware",
])
const EVIDENCE_ENVIRONMENTS = Object.freeze({
  "github-public-mirror": "github-production",
  "npm-bootstrap-and-2fa": "npm-production",
  "npm-trusted-publisher": "npm-production",
  "openresty-test": "openresty-test",
  "openresty-production": "openresty-production",
  "accio-official-connector": "accio-official",
  "real-cli-e2e": "adrate-production-test",
  "windows-hardware": "windows-hardware",
  "accio-capacity": "accio-production",
})
// 两个 required 列表必须是 EXTERNAL_GATE_IDS 的保序子集：readiness 文档用
// JSON.stringify 逐字节比对 requiredGateIds，顺序漂移会让合同静默错位。
for (const [name, ids] of [
  ["prerelease", PRERELEASE_GATE_IDS],
  ["stable", STABLE_GATE_IDS],
]) {
  if (
    JSON.stringify(EXTERNAL_GATE_IDS.filter((id) => ids.includes(id))) !==
    JSON.stringify(ids)
  ) {
    throw new Error(
      `${name} gate IDs are not an order-preserving subset of EXTERNAL_GATE_IDS.`
    )
  }
}
const TRUSTED_EVIDENCE_PINS_PATH = "release/trusted-evidence-pins.json"

function fail(message) {
  throw new Error(message)
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex")
}

export function assertReproducibleTarballBytes(firstTarball, secondTarball) {
  const firstDigest = sha256(firstTarball)
  const secondDigest = sha256(secondTarball)
  if (firstDigest !== secondDigest) {
    fail("Two clean npm pack reconstructions produced different tarball bytes.")
  }
  return firstDigest
}

function toPosix(path) {
  return path.split(sep).join("/")
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort())
  )
}

function isCanonicalIso(value) {
  if (typeof value !== "string") return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
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

async function gitIsAncestor(root, ancestor, descendant) {
  try {
    await execFileAsync(
      "git",
      ["-C", root, "merge-base", "--is-ancestor", ancestor, descendant],
      { encoding: "utf8" }
    )
    return true
  } catch (error) {
    if (error?.code === 1) return false
    throw error
  }
}

const RELEASE_EVIDENCE_ALLOWED_FILES = new Set([
  ".adrate-public-mirror.json",
  "release/external-readiness.json",
  TRUSTED_EVIDENCE_PINS_PATH,
  "release/README.md",
  "release/RELEASE_NOTES-0.1.0.md",
  ...EXTERNAL_GATE_IDS.map((id) => `release/evidence/${id}.json`),
])

function isAllowedReleaseEvidenceChange(path) {
  return RELEASE_EVIDENCE_ALLOWED_FILES.has(path)
}

async function assertReleaseRuntimeCompatibility(
  root,
  testedCommit,
  currentCommit,
  options
) {
  const releaseLabel = options.allowVersionChange ? "Stable" : "Prerelease"
  if (!(await gitIsAncestor(root, testedCommit, currentCommit))) {
    fail(
      `${releaseLabel} tested commit is not an ancestor of the release candidate.`
    )
  }
  const { stdout } = await execFileAsync(
    "git",
    ["-C", root, "diff", "--name-only", "-z", testedCommit, currentCommit],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
  )
  const changed = stdout.split("\0").filter(Boolean)
  for (const path of changed) {
    if (path === "package.json") {
      if (!options.allowVersionChange) {
        fail("Prerelease package.json changed after the tested candidate.")
      }
      const versions = await Promise.all(
        [testedCommit, currentCommit].map(async (commit) => {
          const text = await gitAt(root, ["show", `${commit}:package.json`])
          const value = JSON.parse(text)
          value.version = "<release-train-version>"
          return JSON.stringify(value)
        })
      )
      if (versions[0] !== versions[1]) {
        fail("Stable package.json changed beyond its version.")
      }
      continue
    }
    if (!isAllowedReleaseEvidenceChange(path)) {
      fail(
        `${releaseLabel} candidate runtime drifted after validation: ${path}`
      )
    }
  }
}

export async function assertStableRuntimeCompatibility(
  root,
  testedCommit,
  currentCommit
) {
  await assertReleaseRuntimeCompatibility(root, testedCommit, currentCommit, {
    allowVersionChange: true,
  })
}

export async function assertPrereleaseRuntimeCompatibility(
  root,
  testedCommit,
  currentCommit
) {
  await assertReleaseRuntimeCompatibility(root, testedCommit, currentCommit, {
    allowVersionChange: false,
  })
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

function compareNumericIdentifier(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue)
  const right = parseSemver(rightValue)
  if (!left || !right) fail("Release version is not strict SemVer.")
  for (let index = 0; index < 3; index += 1) {
    const comparison = compareNumericIdentifier(
      left.core[index],
      right.core[index]
    )
    if (comparison !== 0) return comparison
  }
  if (left.prerelease === null) return right.prerelease === null ? 0 : 1
  if (right.prerelease === null) return -1
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifier(leftPart, rightPart)
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

export function releaseChannelForVersion(version) {
  const parsed = parseSemver(version)
  if (!parsed) fail("package.json version is not strict SemVer.")
  return parsed.prerelease === null ? "stable" : "prerelease"
}

function releaseTrainForVersion(version) {
  const parsed = parseSemver(version)
  if (!parsed) fail("Release train version is not strict SemVer.")
  return parsed.core.join(".")
}

export function validateReleaseTrainEvidenceBinding(options) {
  const evidence = options.evidence
  const currentChannel = releaseChannelForVersion(options.currentVersion)
  if (
    options.channel !== currentChannel ||
    evidence.releaseTrain !== releaseTrainForVersion(options.currentVersion) ||
    !SHA1_PATTERN.test(evidence.validatedCommit) ||
    !SHA1_PATTERN.test(evidence.testedCommit) ||
    !SHA256_PATTERN.test(evidence.tarballSha256) ||
    !options.validatedCommitIsAncestor ||
    !options.testedCommitIsAncestor
  ) {
    fail("External evidence is not bound to this release train ancestry.")
  }
  if (options.channel === "prerelease") {
    if (
      evidence.testedVersion !== options.currentVersion ||
      evidence.tarballSha256 !== options.currentArtifactSha256 ||
      !options.runtimeCompatible
    ) {
      fail("Prerelease evidence must bind the tested immutable artifact.")
    }
    return
  }
  if (
    releaseChannelForVersion(evidence.testedVersion) !== "prerelease" ||
    releaseTrainForVersion(evidence.testedVersion) !==
      releaseTrainForVersion(options.currentVersion) ||
    !options.runtimeCompatible
  ) {
    fail(
      "Stable evidence must come from a runtime-identical prerelease in the same train."
    )
  }
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
        "scripts/keychain-smoke.mjs",
      ])
  ) {
    fail("package.json does not match the frozen public package contract.")
  }
}

function countText(text, value) {
  return text.split(value).length - 1
}

export function validatePublishWorkflow(workflow) {
  const normalized = workflow.replaceAll("\r\n", "\n")
  if (sha256(Buffer.from(normalized)) !== EXPECTED_WORKFLOW_SHA256) {
    fail("Publish workflow differs from the closed-world reviewed workflow.")
  }
  const requiredOnce = [
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    EXPECTED_IDENTITY_STEP_COMMAND,
    "pnpm release:external-gate",
    "pnpm release:gate --channel",
    'npm publish "${{ runner.temp }}/release-artifact/adrate-cli-${{ needs.verify.outputs.version }}.tgz"',
    "environment: npm-production",
    "id-token: write",
  ]
  for (const value of requiredOnce) {
    if (countText(normalized, value) !== 1) {
      fail(
        `Publish workflow must contain exactly one reviewed occurrence: ${value}`
      )
    }
  }
  if (
    countText(
      normalized,
      "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd"
    ) !== 1 ||
    countText(
      normalized,
      "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e"
    ) !== 2
  ) {
    fail("Publish workflow action counts drifted.")
  }
  const local = normalized.indexOf("pnpm release:gate --channel")
  const external = normalized.indexOf("pnpm release:external-gate")
  const publish = normalized.indexOf("npm publish ")
  if (
    local < 0 ||
    external < 0 ||
    publish < 0 ||
    local > publish ||
    external > publish
  ) {
    fail("Both release gates must run exactly once before npm publish.")
  }
  const publishJob = normalized.indexOf("\n  publish:\n")
  if (
    publishJob < 0 ||
    normalized.indexOf("id-token: write") < publishJob ||
    normalized.indexOf("environment: npm-production") < publishJob
  ) {
    fail("OIDC and npm-production must exist only in the minimal publish job.")
  }
  const publishSection = normalized.slice(publishJob)
  if (
    publishSection.includes("actions/checkout@") ||
    publishSection.includes("node scripts/") ||
    publishSection.includes("pnpm ")
  ) {
    fail("Privileged publish job must not checkout or execute project code.")
  }
  if (
    /(?:NPM_TOKEN|NODE_AUTH_TOKEN|_authToken|npm_config_[^\s:]*token|secrets\.)/i.test(
      normalized
    ) ||
    /npm publish[^\n]*--provenance/.test(normalized)
  ) {
    fail(
      "Publish workflow contains forbidden token authentication or provenance drift."
    )
  }
}

async function assertWorkflow() {
  validatePublishWorkflow(
    await readFile(resolve(CLI_ROOT, ".github/workflows/publish.yml"), "utf8")
  )
}

function expectedGateIds(channel) {
  return channel === "prerelease" ? PRERELEASE_GATE_IDS : STABLE_GATE_IDS
}

// 证据必须自报它覆盖哪些 channel，且与该 gate 实际被哪些 channel 依赖完全一致。
// 两项 accio gate 当前不被任何 channel 依赖，返回空数组——它们本就不该有证据文件，
// 若有也不会被 verifyExternalReadinessEvidence 消费，这里保持 fail-closed 的诚实值。
function expectedEvidenceChannels(id) {
  const channels = []
  if (PRERELEASE_GATE_IDS.includes(id)) channels.push("prerelease")
  if (STABLE_GATE_IDS.includes(id)) channels.push("stable")
  return channels
}

export function validateTrustedEvidencePinsDocument(document) {
  if (
    !hasExactKeys(document, ["formatVersion", "pins"]) ||
    document.formatVersion !== 1 ||
    document.pins === null ||
    typeof document.pins !== "object" ||
    Array.isArray(document.pins) ||
    JSON.stringify(Object.keys(document.pins)) !==
      JSON.stringify(EXTERNAL_GATE_IDS)
  ) {
    fail("Trusted evidence pins do not match the frozen schema.")
  }

  for (const id of EXTERNAL_GATE_IDS) {
    const pin = document.pins[id]
    if (pin === null) continue
    if (
      !hasExactKeys(pin, ["sha256", "issuer", "environment"]) ||
      !SHA256_PATTERN.test(pin.sha256) ||
      pin.environment !== EVIDENCE_ENVIRONMENTS[id] ||
      typeof pin.issuer !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(pin.issuer)
    ) {
      fail(`Trusted evidence pin is invalid: ${id}`)
    }
  }
  return document.pins
}

export async function verifyTrustedEvidencePins(root) {
  const path = resolve(root, TRUSTED_EVIDENCE_PINS_PATH)
  let info
  try {
    info = await lstat(path)
  } catch {
    fail("Trusted evidence pins file is missing.")
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    fail("Trusted evidence pins must be a regular file.")
  }
  return validateTrustedEvidencePinsDocument(
    await readJson(path, "Trusted evidence pins")
  )
}

export function validateExternalReadinessDocument(readiness) {
  if (
    !hasExactKeys(readiness, [
      "formatVersion",
      "checkedAt",
      "channels",
      "gates",
    ]) ||
    readiness.formatVersion !== 2 ||
    !isCanonicalIso(readiness.checkedAt) ||
    !hasExactKeys(readiness.channels, ["prerelease", "stable"]) ||
    !Array.isArray(readiness.gates) ||
    readiness.gates.length !== EXTERNAL_GATE_IDS.length
  ) {
    fail("External readiness does not match the frozen channel schema.")
  }
  for (const channel of ["prerelease", "stable"]) {
    const entry = readiness.channels[channel]
    if (
      !hasExactKeys(entry, ["status", "requiredGateIds"]) ||
      !["blocked", "pass"].includes(entry.status) ||
      JSON.stringify(entry.requiredGateIds) !==
        JSON.stringify(expectedGateIds(channel))
    ) {
      fail(`External readiness ${channel} channel contract drifted.`)
    }
  }
  for (const [index, gate] of readiness.gates.entries()) {
    const expectedId = EXTERNAL_GATE_IDS[index]
    if (
      !hasExactKeys(gate, [
        "id",
        "status",
        "owner",
        "evidence",
        "blockingReason",
      ]) ||
      gate.id !== expectedId ||
      gate.owner !== "Boss" ||
      !["blocked", "pass"].includes(gate.status)
    ) {
      fail("External readiness gate IDs or fields drifted.")
    }
    if (gate.status === "blocked") {
      if (
        gate.evidence !== null ||
        typeof gate.blockingReason !== "string" ||
        gate.blockingReason.length === 0
      ) {
        fail(`Blocked external gate has invalid evidence fields: ${gate.id}`)
      }
    } else if (
      !hasExactKeys(gate.evidence, ["path", "sha256"]) ||
      gate.evidence.path !== `release/evidence/${gate.id}.json` ||
      !SHA256_PATTERN.test(gate.evidence.sha256) ||
      gate.blockingReason !== null
    ) {
      fail(`Passing external gate has invalid evidence binding: ${gate.id}`)
    }
  }
  const gates = new Map(readiness.gates.map((gate) => [gate.id, gate]))
  for (const channel of ["prerelease", "stable"]) {
    const calculated = expectedGateIds(channel).every(
      (id) => gates.get(id)?.status === "pass"
    )
      ? "pass"
      : "blocked"
    if (readiness.channels[channel].status !== calculated) {
      fail(
        `External readiness ${channel} status is not derived from its gates.`
      )
    }
  }
  return readiness
}

function assertEvidencePath(root, path) {
  if (
    typeof path !== "string" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail("External evidence path escaped the release root.")
  }
  const target = resolve(root, path)
  const fromRoot = relative(root, target)
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    fail("External evidence path escaped the release root.")
  }
  return target
}

export async function verifyExternalReadinessEvidence(options) {
  const readiness = validateExternalReadinessDocument(options.readiness)
  const required = expectedGateIds(options.channel)
  if (readiness.channels[options.channel]?.status !== "pass") {
    fail(`External ${options.channel} release gates remain blocked.`)
  }
  const pins = await verifyTrustedEvidencePins(options.root)
  for (const id of required) {
    const gate = readiness.gates.find((candidate) => candidate.id === id)
    const pin = pins[id]
    if (!pin || !hasExactKeys(pin, ["sha256", "issuer", "environment"])) {
      fail(`External evidence has no reviewed trust pin: ${id}`)
    }
    if (
      pin.sha256 !== gate.evidence.sha256 ||
      !SHA256_PATTERN.test(pin.sha256) ||
      pin.environment !== EVIDENCE_ENVIRONMENTS[id] ||
      typeof pin.issuer !== "string" ||
      pin.issuer.length === 0
    ) {
      fail(`External evidence trust pin is invalid: ${id}`)
    }
    const path = assertEvidencePath(options.root, gate.evidence.path)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) {
      fail(`External evidence is not a regular file: ${id}`)
    }
    const bytes = await readFile(path)
    if (sha256(bytes) !== pin.sha256) {
      fail(`External evidence digest drifted: ${id}`)
    }
    let evidence
    try {
      evidence = JSON.parse(bytes.toString("utf8"))
    } catch {
      fail(`External evidence is not JSON: ${id}`)
    }
    if (
      !hasExactKeys(evidence, [
        "formatVersion",
        "gateId",
        "releaseTrain",
        "validatedCommit",
        "testedVersion",
        "testedCommit",
        "tarballSha256",
        "channels",
        "environment",
        "issuer",
        "issuedAt",
        "result",
      ]) ||
      evidence.formatVersion !== 1 ||
      evidence.gateId !== id ||
      JSON.stringify(evidence.channels) !==
        JSON.stringify(expectedEvidenceChannels(id)) ||
      evidence.environment !== pin.environment ||
      evidence.issuer !== pin.issuer ||
      !isCanonicalIso(evidence.issuedAt) ||
      Date.parse(evidence.issuedAt) > Date.parse(readiness.checkedAt) ||
      evidence.result !== "pass"
    ) {
      fail(`External evidence content is not trusted: ${id}`)
    }
    const validatedCommitIsAncestor = await gitIsAncestor(
      options.root,
      evidence.validatedCommit,
      options.commit
    )
    const testedCommitIsAncestor = await gitIsAncestor(
      options.root,
      evidence.testedCommit,
      options.commit
    )
    let runtimeCompatible = true
    try {
      await assertReleaseRuntimeCompatibility(
        options.root,
        evidence.testedCommit,
        options.commit,
        { allowVersionChange: options.channel === "stable" }
      )
    } catch {
      runtimeCompatible = false
    }
    validateReleaseTrainEvidenceBinding({
      channel: options.channel,
      currentVersion: options.version,
      currentCommit: options.commit,
      currentArtifactSha256: options.currentArtifactSha256,
      evidence,
      validatedCommitIsAncestor,
      testedCommitIsAncestor,
      runtimeCompatible,
    })
  }
}

async function assertDocumentation() {
  const documents = await Promise.all(
    ["README.md", "release/RELEASE_NOTES-0.1.0.md"].map(async (path) => ({
      path,
      text: await readFile(resolve(CLI_ROOT, path), "utf8"),
    }))
  )
  for (const document of documents) {
    for (const required of [
      ...INSTALL_COMMANDS,
      ...REQUIRED_COMMAND_EXAMPLES,
      ...EXPECTED_TARBALL_FILES,
    ]) {
      if (!document.text.includes(required)) {
        fail(`${document.path} is missing frozen release text: ${required}`)
      }
    }
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
  // 目录逐层遍历得不到按完整路径的全局顺序，必须在这里统一重排。
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
          ADRATE_NO_UPDATE_NOTIFIER: "1",
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
    // extractAndHash 已按 comparePackagePath 全局排序；这里再排一次是
    // 防御性的，且必须用同一个比较器，不能退回 localeCompare。
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

async function assertReproduciblePackage(
  sourceFiles,
  packageJson,
  options = {}
) {
  const root = await mkdtemp(resolve(tmpdir(), "adrate-release-gate-"))
  try {
    const firstDirectory = resolve(root, "first")
    const secondDirectory = resolve(root, "second")
    await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory)])
    const firstSnapshot = resolve(firstDirectory, "snapshot")
    const secondSnapshot = resolve(secondDirectory, "snapshot")
    await Promise.all([
      materializeSnapshot(firstSnapshot, sourceFiles),
      materializeSnapshot(secondSnapshot, sourceFiles),
    ])
    const [first, second] = await Promise.all([
      pack(firstSnapshot, firstDirectory),
      pack(secondSnapshot, secondDirectory),
    ])
    const [firstTarball, secondTarball] = await Promise.all([
      readFile(first),
      readFile(second),
    ])
    assertReproducibleTarballBytes(firstTarball, secondTarball)
    const [firstEntries, secondEntries] = await Promise.all([
      tarballEntries(first),
      tarballEntries(second),
    ])
    if (
      JSON.stringify(firstEntries) !== JSON.stringify(EXPECTED_TARBALL_FILES) ||
      JSON.stringify(secondEntries) !== JSON.stringify(EXPECTED_TARBALL_FILES)
    ) {
      fail("npm tarball does not contain the frozen 15 files.")
    }
    const [firstExtracted, secondExtracted] = await Promise.all([
      extractAndHash(first, resolve(root, "unpack-first")),
      extractAndHash(second, resolve(root, "unpack-second")),
    ])
    if (
      JSON.stringify([...firstExtracted.hashes]) !==
      JSON.stringify([...secondExtracted.hashes])
    ) {
      fail(
        "Two clean npm pack reconstructions produced different file contents."
      )
    }
    await assertPackedPackage(firstExtracted.packageRoot, packageJson.version)
    await assertPackedPackage(secondExtracted.packageRoot, packageJson.version)
    if (options.artifactDirectory) {
      await persistReleaseArtifact(
        first,
        firstExtracted.hashes,
        options.identity,
        options.artifactDirectory
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function parseArtifactManifest(value, identity) {
  if (
    !hasExactKeys(value, [
      "formatVersion",
      "packageName",
      "version",
      "channel",
      "distTag",
      "tag",
      "commit",
      "tarball",
      "sha256",
      "files",
    ]) ||
    value.formatVersion !== 1 ||
    value.packageName !== "@adrate/cli" ||
    value.version !== identity.version ||
    value.channel !== identity.channel ||
    value.distTag !== identity.distTag ||
    value.tag !== identity.tag ||
    value.commit !== identity.commit ||
    value.tarball !== `adrate-cli-${identity.version}.tgz` ||
    !SHA256_PATTERN.test(value.sha256) ||
    !Array.isArray(value.files) ||
    value.files.length !== EXPECTED_TARBALL_FILES.length
  ) {
    fail("Release artifact manifest does not match its release identity.")
  }
  for (const [index, file] of value.files.entries()) {
    if (
      !hasExactKeys(file, ["path", "sha256"]) ||
      file.path !== EXPECTED_TARBALL_FILES[index] ||
      !SHA256_PATTERN.test(file.sha256)
    ) {
      fail("Release artifact file digest manifest drifted.")
    }
  }
  return value
}

export async function verifyReleaseArtifact(artifactDirectory, identity) {
  const validatedIdentity = validateReleaseIdentity(identity)
  const root = await realpath(assertArtifactDirectoryTarget(artifactDirectory))
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail("Release artifact root must be a real directory.")
  }
  const expectedTarball = `adrate-cli-${validatedIdentity.version}.tgz`
  const entries = await readdir(root, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  if (
    JSON.stringify(entries.map((entry) => entry.name)) !==
      JSON.stringify([expectedTarball, RELEASE_ARTIFACT_MANIFEST].sort()) ||
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
  ) {
    fail(
      "Release artifact directory must contain exactly the tarball and digest manifest."
    )
  }
  const manifest = parseArtifactManifest(
    await readJson(
      resolve(root, RELEASE_ARTIFACT_MANIFEST),
      "release artifact manifest"
    ),
    validatedIdentity
  )
  const tarball = resolve(root, expectedTarball)
  if (sha256(await readFile(tarball)) !== manifest.sha256) {
    fail("Release artifact tarball digest does not match its manifest.")
  }
  if (
    JSON.stringify(await tarballEntries(tarball)) !==
    JSON.stringify(EXPECTED_TARBALL_FILES)
  ) {
    fail("Release artifact tarball does not contain the frozen 15 files.")
  }
  const temporary = await mkdtemp(resolve(tmpdir(), "adrate-artifact-verify-"))
  try {
    const extracted = await extractAndHash(tarball, temporary)
    if (
      JSON.stringify(
        [...extracted.hashes].map(([path, fileSha256]) => ({
          path,
          sha256: fileSha256,
        }))
      ) !== JSON.stringify(manifest.files)
    ) {
      fail("Release artifact extracted hashes do not match its manifest.")
    }
    await assertPackedPackage(extracted.packageRoot, validatedIdentity.version)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  return { tarball, sha256: manifest.sha256, identity: validatedIdentity }
}

export function assertRegistryMonotonicResponse(
  candidateVersion,
  channel,
  response
) {
  if (!parseSemver(candidateVersion))
    fail("Candidate registry version is not strict SemVer.")
  const distTag = distTagForChannel(channel)
  if (response.status < 200 || response.status >= 300) {
    fail("npm registry dist-tag lookup failed closed.")
  }
  let document
  try {
    document = JSON.parse(response.text)
  } catch {
    fail("npm registry dist-tag response is not JSON.")
  }
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document)
  ) {
    fail("npm registry dist-tag response has an invalid shape.")
  }
  const current = document[distTag]
  if (current === undefined) return
  if (!parseSemver(current))
    fail(`npm ${distTag} dist-tag is not strict SemVer.`)
  if (compareSemver(candidateVersion, current) <= 0) {
    fail(`Candidate version would roll back or repeat npm dist-tag ${distTag}.`)
  }
}

async function readRegistryText(response) {
  const declared = response.headers.get("content-length")
  if (declared !== null) {
    if (!/^\d+$/.test(declared) || Number(declared) > REGISTRY_MAX_BYTES) {
      await response.body?.cancel()
      fail("npm registry dist-tag response size is invalid.")
    }
  }
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const result = await reader.read()
    if (result.done) break
    size += result.value.byteLength
    if (size > REGISTRY_MAX_BYTES) {
      await reader.cancel()
      fail("npm registry dist-tag response is too large.")
    }
    chunks.push(result.value)
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    size
  ).toString("utf8")
}

async function assertRegistryMonotonic(candidateVersion, channel) {
  let response
  try {
    response = await fetch(REGISTRY_PACKAGE_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    })
  } catch {
    fail("npm registry dist-tag lookup failed closed.")
  }
  assertRegistryMonotonicResponse(candidateVersion, channel, {
    status: response.status,
    text: await readRegistryText(response),
  })
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
  await assertWorkflow()
  await assertDocumentation()
  await scanTrackedFiles()
  const readiness = await readJson(
    resolve(CLI_ROOT, "release/external-readiness.json"),
    "external release readiness"
  )
  validateExternalReadinessDocument(readiness)
  await verifyTrustedEvidencePins(CLI_ROOT)
  const sourceFiles = await collectReleaseSource(CLI_ROOT, {
    requireCommitted:
      options.requireClean || Boolean(options.artifactDirectory),
  })
  await assertReproduciblePackage(sourceFiles, packageJson, {
    ...(options.artifactDirectory
      ? { artifactDirectory: options.artifactDirectory, identity }
      : {}),
  })
}

async function assertExternalGate(options) {
  const packageJson = await loadPackageJson()
  const identity = await releaseIdentityFromOptions(packageJson, options, false)
  const channel = identity?.channel ?? options.channel
  if (!channel) fail("External release gate requires an explicit channel.")
  if (channel !== "prerelease" && channel !== "stable") {
    fail("External release channel is invalid.")
  }
  if (identity && !options.artifactDirectory) {
    fail("Release-bound external gate requires the immutable artifact.")
  }
  const artifact = identity
    ? await verifyReleaseArtifact(options.artifactDirectory, identity)
    : null
  const readiness = await readJson(
    resolve(CLI_ROOT, "release/external-readiness.json"),
    "external release readiness"
  )
  await verifyExternalReadinessEvidence({
    root: CLI_ROOT,
    readiness,
    channel,
    version: packageJson.version,
    commit: identity?.commit ?? (await gitAt(CLI_ROOT, ["rev-parse", "HEAD"])),
    currentArtifactSha256: artifact?.sha256,
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
    ["--external", "external"],
    ["--identity", "identity"],
    ["--publish-artifact", "publishArtifact"],
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
  if (
    options.artifactDirectory &&
    !["local", "external", "publishArtifact"].includes(options.mode)
  ) {
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
  if (options.mode === "external") {
    await assertExternalGate(options)
    process.stdout.write("External release gate PASS\n")
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
  if (!options.artifactDirectory)
    fail("Publish artifact gate requires --artifact-dir.")
  await verifyReleaseArtifact(options.artifactDirectory, identity)
  await assertRegistryMonotonic(identity.version, identity.channel)
  process.stdout.write("Publish artifact gate PASS\n")
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  main().catch((error) => {
    const message =
      error instanceof Error ? error.message : "Unknown release gate failure."
    process.stderr.write(`Release blocked: ${message}\n`)
    process.exitCode = 1
  })
}
