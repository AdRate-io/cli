import { createHash } from "node:crypto"

export const SKILL_NAMES = Object.freeze(["adrate-shared", "adrate-ads"])

export const EXPECTED_SKILL_MANIFESTS = Object.freeze({
  "adrate-shared": Object.freeze({
    formatVersion: 1,
    name: "adrate-shared",
    description:
      "Operate AdRate CLI authentication, recovery, pagination, rate limits, and ownership boundaries safely. Use whenever an Agent invokes AdRate or interprets its envelopes and Command results.",
    version: "1.0.0",
    minCliVersion: "0.1.0",
    requiredBin: "adrate",
    cliHelp: "adrate skills read adrate-shared",
    shellSha256:
      "357a0b4e56169e234ae02ebaa436e30ca953fdb30f93503e39901ff91a71dbe8",
    contentSha256:
      "b8a4ee39d8b0611c1178ad8b931d8d11787844cafafe3dfde5b1ab2876f39793",
  }),
  "adrate-ads": Object.freeze({
    formatVersion: 1,
    name: "adrate-ads",
    description:
      "Inspect AdRate Campaigns and reports, select TikTok authorizations, and apply single-Campaign status changes safely. Use for every M0 advertising read or write operation.",
    version: "1.0.0",
    minCliVersion: "0.1.0",
    requiredBin: "adrate",
    cliHelp: "adrate skills read adrate-ads",
    shellSha256:
      "2ad811bd131617f078d6c6fedc20f98efa1e72758c26aade947d8665a2ed4419",
    contentSha256:
      "f7e4245e3db68a6b7ba91394ef4a570111bb4be453e1a21c210c0ef181997f7f",
  }),
})

export const EXPECTED_OPENAI_CONFIGS = Object.freeze({
  "adrate-shared": Object.freeze({
    displayName: "AdRate Shared Safety",
    shortDescription: "Safe authentication, recovery, and CLI operation",
    defaultPrompt:
      "Use $adrate-shared to operate AdRate CLI safely and recover ambiguous results.",
  }),
  "adrate-ads": Object.freeze({
    displayName: "AdRate Ads Operations",
    shortDescription: "Inspect Campaigns and apply safe status changes",
    defaultPrompt:
      "Use $adrate-ads to inspect AdRate Campaigns and make a safe ENABLE or DISABLE change.",
  }),
})

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value).sort()
  return (
    keys.length === expected.length &&
    [...expected].sort().every((key, index) => keys[index] === key)
  )
}

export function normalizeSkillText(value) {
  return `${value.replace(/\r\n?/g, "\n").replace(/\n*$/, "")}\n`
}

export function sha256SkillText(value) {
  return createHash("sha256")
    .update(normalizeSkillText(value), "utf8")
    .digest("hex")
}

function parseSemver(value) {
  const match = SEMVER_PATTERN.exec(value)
  if (!match) return null
  const prerelease = match[4]?.split(".") ?? []
  if (
    prerelease.some(
      (identifier) => /^\d+$/.test(identifier) && /^0\d+/.test(identifier)
    )
  ) {
    return null
  }
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease,
  }
}

export function isValidSemver(value) {
  return typeof value === "string" && parseSemver(value) !== null
}

export function compareSemver(left, right) {
  const leftVersion = parseSemver(left)
  const rightVersion = parseSemver(right)
  if (!leftVersion || !rightVersion) {
    throw new Error("Cannot compare an invalid semantic version.")
  }
  for (const key of ["major", "minor", "patch"]) {
    if (leftVersion[key] < rightVersion[key]) return -1
    if (leftVersion[key] > rightVersion[key]) return 1
  }
  const leftPre = leftVersion.prerelease
  const rightPre = rightVersion.prerelease
  if (leftPre.length === 0 && rightPre.length === 0) return 0
  if (leftPre.length === 0) return 1
  if (rightPre.length === 0) return -1
  const length = Math.max(leftPre.length, rightPre.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftPre[index]
    const rightPart = rightPre[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) {
      return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1
    }
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

function isSafeText(value, maximum) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const code = character.codePointAt(0)
      return code !== undefined && (code <= 0x1f || code === 0x7f)
    })
  )
}

export function parseSkillManifest(text, expectedName) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "formatVersion",
      "name",
      "description",
      "version",
      "minCliVersion",
      "requiredBin",
      "cliHelp",
      "shellSha256",
      "contentSha256",
    ]) ||
    value.formatVersion !== 1 ||
    !isSafeText(value.name, 64) ||
    !SKILL_NAME_PATTERN.test(value.name) ||
    (expectedName !== undefined && value.name !== expectedName) ||
    !isSafeText(value.description, 1_024) ||
    !isValidSemver(value.version) ||
    !isValidSemver(value.minCliVersion) ||
    value.requiredBin !== "adrate" ||
    value.cliHelp !== `adrate skills read ${value.name}` ||
    typeof value.shellSha256 !== "string" ||
    !SHA256_PATTERN.test(value.shellSha256) ||
    typeof value.contentSha256 !== "string" ||
    !SHA256_PATTERN.test(value.contentSha256)
  ) {
    return null
  }
  return {
    formatVersion: 1,
    name: value.name,
    description: value.description,
    version: value.version,
    minCliVersion: value.minCliVersion,
    requiredBin: "adrate",
    cliHelp: value.cliHelp,
    shellSha256: value.shellSha256,
    contentSha256: value.contentSha256,
  }
}

function parseYamlString(value) {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.includes("\t")) return null
  if (!trimmed.startsWith('"')) return null
  try {
    const parsed = JSON.parse(trimmed)
    return typeof parsed === "string" ? parsed : null
  } catch {
    return null
  }
}

export function parseSkillFrontmatter(text) {
  const normalized = text.replace(/\r\n?/g, "\n")
  if (!normalized.startsWith("---\n")) return null
  const boundary = normalized.indexOf("\n---\n", 4)
  if (boundary === -1) return null
  const lines = normalized.slice(4, boundary).split("\n")
  const top = new Map()
  const metadata = new Map()
  let inMetadata = false
  for (const line of lines) {
    if (line.length === 0 || line.includes("\t")) return null
    const child = /^ {2}([A-Za-z][A-Za-z0-9]*):\s*(.+)$/.exec(line)
    if (child) {
      if (!inMetadata || metadata.has(child[1])) return null
      const parsed = parseYamlString(child[2])
      if (parsed === null) return null
      metadata.set(child[1], parsed)
      continue
    }
    const parent = /^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/.exec(line)
    if (!parent || top.has(parent[1])) return null
    const key = parent[1]
    const raw = parent[2] ?? ""
    if (key === "metadata") {
      if (raw.trim().length > 0) return null
      top.set(key, "")
      inMetadata = true
      continue
    }
    inMetadata = false
    const parsed = parseYamlString(raw)
    if (parsed === null) return null
    top.set(key, parsed)
  }
  if (
    !hasExactKeys(Object.fromEntries(top), [
      "name",
      "description",
      "metadata",
    ]) ||
    !hasExactKeys(Object.fromEntries(metadata), [
      "version",
      "minCliVersion",
      "requiredBin",
      "cliHelp",
    ])
  ) {
    return null
  }
  const name = top.get("name")
  const description = top.get("description")
  const version = metadata.get("version")
  const minCliVersion = metadata.get("minCliVersion")
  const requiredBin = metadata.get("requiredBin")
  const cliHelp = metadata.get("cliHelp")
  if (
    !isSafeText(name, 64) ||
    !SKILL_NAME_PATTERN.test(name) ||
    !isSafeText(description, 1_024) ||
    !isValidSemver(version) ||
    !isValidSemver(minCliVersion) ||
    requiredBin !== "adrate" ||
    cliHelp !== `adrate skills read ${name}`
  ) {
    return null
  }
  return {
    name,
    description,
    metadata: { version, minCliVersion, requiredBin, cliHelp },
  }
}

export function parseOpenAiConfig(text) {
  const normalized = text.replace(/\r\n?/g, "\n")
  const lines = normalized.replace(/\n*$/, "").split("\n")
  if (lines[0] !== "interface:" || lines.length !== 4) return null
  const values = new Map()
  for (const line of lines.slice(1)) {
    const match = /^ {2}([a-z_]+):\s*(.+)$/.exec(line)
    if (!match || values.has(match[1])) return null
    const parsed = parseYamlString(match[2])
    if (parsed === null) return null
    values.set(match[1], parsed)
  }
  if (
    !hasExactKeys(Object.fromEntries(values), [
      "display_name",
      "short_description",
      "default_prompt",
    ])
  ) {
    return null
  }
  const displayName = values.get("display_name")
  const shortDescription = values.get("short_description")
  const defaultPrompt = values.get("default_prompt")
  if (
    !isSafeText(displayName, 64) ||
    !isSafeText(shortDescription, 128) ||
    !isSafeText(defaultPrompt, 1_024)
  ) {
    return null
  }
  return { displayName, shortDescription, defaultPrompt }
}

export function shellMatchesManifest({ shell, shellSha256, manifest }) {
  return (
    shell.name === manifest.name &&
    shell.description === manifest.description &&
    shell.metadata.version === manifest.version &&
    shell.metadata.minCliVersion === manifest.minCliVersion &&
    shell.metadata.requiredBin === manifest.requiredBin &&
    shell.metadata.cliHelp === manifest.cliHelp &&
    shellSha256 === manifest.shellSha256
  )
}
