import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { gzipSync } from "node:zlib"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import {
  EXPECTED_TARBALL_FILES,
  EXTERNAL_GATE_IDS,
  PRERELEASE_GATE_IDS,
  STABLE_GATE_IDS,
  assertPrereleaseRuntimeCompatibility,
  assertRegistryMonotonicResponse,
  assertReleaseGitIdentity,
  assertReproducibleTarballBytes,
  assertStableRuntimeCompatibility,
  validateExternalReadinessDocument,
  validatePublishWorkflow,
  validateReleaseIdentity,
  validateReleaseTrainEvidenceBinding,
  validateTrustedEvidencePinsDocument,
  verifyExternalReadinessEvidence,
  verifyTrustedEvidencePins,
} from "../scripts/release-gate.mjs"

const execFileAsync = promisify(execFile)
const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url))
const roots: Array<string> = []
const ENVIRONMENTS: Record<string, string> = {
  "github-public-mirror": "github-production",
  "npm-bootstrap-and-2fa": "npm-production",
  "npm-trusted-publisher": "npm-production",
  "openresty-test": "openresty-test",
  "openresty-production": "openresty-production",
  "accio-official-connector": "accio-official",
  "real-cli-e2e": "adrate-production-test",
  "windows-hardware": "windows-hardware",
  "accio-capacity": "accio-production",
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

function clone<T>(value: T): T {
  return structuredClone(value)
}

function writeTarOctal(
  header: Buffer,
  value: number,
  offset: number,
  length: number
) {
  header.write(
    `${value.toString(8).padStart(length - 1, "0")}\0`,
    offset,
    length,
    "ascii"
  )
}

function tarEntry(
  name: string,
  content: string,
  options: { mode?: number; mtime?: number } = {}
) {
  const body = Buffer.from(content)
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, "utf8")
  writeTarOctal(header, options.mode ?? 0o644, 100, 8)
  writeTarOctal(header, 0, 108, 8)
  writeTarOctal(header, 0, 116, 8)
  writeTarOctal(header, body.length, 124, 12)
  writeTarOctal(header, options.mtime ?? 0, 136, 12)
  header.fill(0x20, 148, 156)
  header.write("0", 156, 1, "ascii")
  header.write("ustar\0", 257, 6, "ascii")
  header.write("00", 263, 2, "ascii")
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii")
  header[154] = 0
  header[155] = 0x20
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512)
  return Buffer.concat([header, body, padding])
}

function tarball(
  entries: Array<{
    name: string
    content: string
    mode?: number
    mtime?: number
  }>
) {
  return gzipSync(
    Buffer.concat([
      ...entries.map((entry) => tarEntry(entry.name, entry.content, entry)),
      Buffer.alloc(1024),
    ]),
    { level: 9 }
  )
}

async function readinessFixture(): Promise<Record<string, any>> {
  return JSON.parse(
    await readFile(join(CLI_ROOT, "release/external-readiness.json"), "utf8")
  ) as Record<string, any>
}

function makePrereleasePassing(readiness: Record<string, any>) {
  for (const gate of readiness.gates) {
    if (PRERELEASE_GATE_IDS.includes(gate.id)) {
      gate.status = "pass"
      gate.evidence = {
        path: `release/evidence/${gate.id}.json`,
        sha256: "0".repeat(64),
      }
      gate.blockingReason = null
    }
  }
  readiness.channels.prerelease.status = "pass"
  readiness.channels.stable.status = "blocked"
  return readiness
}

async function evidenceFixture(
  options: { selfSigned?: boolean; reviewedPins?: boolean } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "adrate-release-evidence-"))
  roots.push(root)
  await execFileAsync("git", ["init", "--initial-branch=main", root])
  await execFileAsync("git", [
    "-C",
    root,
    "config",
    "user.email",
    "test@adrate.local",
  ])
  await execFileAsync("git", ["-C", root, "config", "user.name", "AdRate Test"])
  await writeFile(
    join(root, "package.json"),
    '{"name":"@adrate/cli","version":"0.1.0-beta.1"}\n'
  )
  await mkdir(join(root, "src"))
  await writeFile(join(root, "src/runtime.ts"), "export const value = 1\n")
  await execFileAsync("git", ["-C", root, "add", "."])
  await execFileAsync("git", ["-C", root, "commit", "-m", "tested candidate"])
  const testedCommit = (
    await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])
  ).stdout.trim()
  const readiness = makePrereleasePassing(await readinessFixture())
  const pins: Record<
    string,
    { sha256: string; issuer: string; environment: string } | null
  > = Object.fromEntries(EXTERNAL_GATE_IDS.map((id) => [id, null]))
  for (const id of PRERELEASE_GATE_IDS) {
    const evidence = {
      formatVersion: 1,
      gateId: id,
      releaseTrain: "0.1.0",
      validatedCommit: testedCommit,
      testedVersion: "0.1.0-beta.1",
      testedCommit,
      tarballSha256: "b".repeat(64),
      channels: ["prerelease", "stable"],
      environment: ENVIRONMENTS[id]!,
      issuer:
        options.selfSigned && id === PRERELEASE_GATE_IDS[0]
          ? "attacker-self-signed"
          : "adrate-release-review-board",
      issuedAt: "2026-08-01T00:00:00.000Z",
      result: "pass",
    }
    const text = `${JSON.stringify(evidence, null, 2)}\n`
    const path = join(root, `release/evidence/${id}.json`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
    const digest = createHash("sha256").update(text).digest("hex")
    const gate = readiness.gates.find((candidate: any) => candidate.id === id)
    gate.evidence.sha256 = digest
    if (options.reviewedPins !== false) {
      pins[id] = {
        sha256: digest,
        issuer: "adrate-release-review-board",
        environment: ENVIRONMENTS[id]!,
      }
    }
  }
  await writeFile(
    join(root, "release/external-readiness.json"),
    `${JSON.stringify(readiness, null, 2)}\n`
  )
  await writeFile(
    join(root, "release/trusted-evidence-pins.json"),
    `${JSON.stringify({ formatVersion: 1, pins }, null, 2)}\n`
  )
  await writeFile(join(root, "release/README.md"), "# Release review\n")
  await execFileAsync("git", ["-C", root, "add", "."])
  await execFileAsync("git", ["-C", root, "commit", "-m", "reviewed evidence"])
  const currentCommit = (
    await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])
  ).stdout.trim()
  return { root, readiness, testedCommit, currentCommit }
}

describe("release gate", () => {
  /**
   * 回归（2026-08-03 实际烧掉一个版本号）：tarball 的冻结文件清单存在**两份独立
   * 副本**——release-gate.mjs 的 EXPECTED_TARBALL_FILES，和 publish.yml 里
   * "Reverify artifact" 步骤内联的 expectedFiles。两者之间原本没有任何交叉校验。
   *
   * 加 LICENSE 时只改了前者，本地闸门与外部闸门都 PASS（它们都读前者），
   * 但发布 job 在 npm publish 之前用后者复验，报 "artifact identity drifted" 失败。
   * 由于 protect-release-tags 禁止删除与非快进，tag 无法重用，该版本号直接作废。
   */
  it("publish.yml 内联的 expectedFiles 必须与 EXPECTED_TARBALL_FILES 完全一致", async () => {
    const workflow = await readFile(
      join(CLI_ROOT, ".github/workflows/publish.yml"),
      "utf8"
    )
    // 两侧都对清单调用 .sort()，所以源码书写顺序无关，比的是排序后的内容。
    // 同时钉死 .sort() 本身：workflow 的复验是按下标逐项比对的，去掉排序会让
    // 两侧顺序口径分叉，而失败信息只有一句 "artifact identity drifted"。
    const match = /expectedFiles = \[([^\]]*)\]\.sort\(\)/.exec(workflow)
    if (!match?.[1]) {
      throw new Error("publish.yml 里找不到 expectedFiles = [...].sort()")
    }
    const inWorkflow = [...match[1].matchAll(/"([^"]+)"/g)]
      .map((entry) => entry[1] as string)
      .sort()
    expect(inWorkflow).toStrictEqual([...EXPECTED_TARBALL_FILES])
  })

  it("passes the local reproducible package and supply-chain checks", async () => {
    const result = await execFileAsync(
      process.execPath,
      ["scripts/release-gate.mjs", "--local"],
      { cwd: CLI_ROOT, maxBuffer: 4 * 1024 * 1024 }
    )
    expect(result.stdout).toBe("Local release gate PASS\n")
    expect(result.stderr).toBe("")
  }, 30_000)

  // 从 readiness 的真实状态派生断言，而不是写死"两个 channel 都 blocked"。
  // 取证是一个合法的状态推进：某个 channel 拿到全部证据后本就应该不再以
  // "remain blocked" 拒绝。写死状态会让正常取证把这条测试打红，进而逼人去
  // 改测试迁就现实——那正好废掉了这条闸门。无论哪种状态它都必须 fail-closed，
  // 差别只在拒绝的理由。
  it("refuses every channel whose readiness gates are not all pass", async () => {
    const readiness = await readinessFixture()
    for (const channel of ["prerelease", "stable"]) {
      const run = execFileAsync(
        process.execPath,
        ["scripts/release-gate.mjs", "--external", "--channel", channel],
        { cwd: CLI_ROOT }
      )
      if (readiness.channels[channel].status === "blocked") {
        await expect(run).rejects.toMatchObject({
          stderr: expect.stringContaining(
            `External ${channel} release gates remain blocked`
          ),
        })
        continue
      }
      // 已取证的 channel 不能再用 "remain blocked" 搪塞，但仍必须拒绝——
      // 此处缺 tag/commit 身份，且证据绑定的 commit 只存在于公开镜像仓库。
      await expect(run).rejects.toMatchObject({
        stderr: expect.not.stringContaining(
          `External ${channel} release gates remain blocked`
        ),
      })
    }
  })
})

describe("whole-tarball reproducibility", () => {
  it("accepts byte-identical archives and rejects every archive-level drift", () => {
    const entries = [
      { name: "package/a.txt", content: "a\n" },
      { name: "package/b.txt", content: "b\n" },
    ]
    const expected = tarball(entries)
    expect(
      assertReproducibleTarballBytes(expected, Buffer.from(expected))
    ).toBe(createHash("sha256").update(expected).digest("hex"))

    const gzipMetadataDrift = Buffer.from(expected)
    gzipMetadataDrift[9] = gzipMetadataDrift[9] === 0 ? 3 : 0
    const variants = [
      tarball([{ name: "package/renamed.txt", content: "a\n" }, entries[1]!]),
      tarball([...entries].reverse()),
      tarball([{ ...entries[0]!, mode: 0o600 }, entries[1]!]),
      tarball([{ ...entries[0]!, mtime: 1 }, entries[1]!]),
      gzipMetadataDrift,
    ]
    for (const variant of variants) {
      expect(() => assertReproducibleTarballBytes(expected, variant)).toThrow(
        "different tarball bytes"
      )
    }
  })
})

describe("closed-world publish workflow", () => {
  it("accepts only the reviewed workflow bytes and security structure", async () => {
    const workflow = await readFile(
      join(CLI_ROOT, ".github/workflows/publish.yml"),
      "utf8"
    )
    expect(() => validatePublishWorkflow(workflow)).not.toThrow()
    const mutations = [
      `${workflow}\n# pnpm release:external-gate\n`,
      workflow.replace("pnpm release:external-gate", "echo external-gate"),
      workflow.replace(
        "pnpm release:gate --channel",
        "echo local-gate --channel"
      ),
      workflow.replace(
        "permissions:\n      contents: read\n    outputs:",
        "permissions:\n      contents: write\n    outputs:"
      ),
      workflow.replace(
        "- name: Download this run's immutable artifact",
        "- uses: attacker/action@deadbeef\n      - name: Download this run's immutable artifact"
      ),
      workflow.replace(
        'npm publish "${{ runner.temp }}/release-artifact/adrate-cli-${{ needs.verify.outputs.version }}.tgz"',
        "npm publish ."
      ),
      workflow.replace(
        "- name: Publish the exact verified tarball",
        "- name: Late external gate\n        run: pnpm release:external-gate\n\n      - name: Publish the exact verified tarball"
      ),
      workflow.replace(
        "environment: npm-production",
        "environment: npm-production\n    env:\n      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}"
      ),
      workflow.replace(
        "- name: Use Node.js 24\n        uses: actions/setup-node@",
        "- name: Privileged checkout\n        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd\n\n      - name: Use Node.js 24\n        uses: actions/setup-node@"
      ),
    ]
    for (const mutation of mutations) {
      expect(() => validatePublishWorkflow(mutation)).toThrow(
        "closed-world reviewed workflow"
      )
    }
  })
})

/**
 * 复刻公开镜像根目录：identity 模式要求脚本所在仓库就是 Git 顶层，
 * 因此必须把两个脚本和 package.json 拷进独立仓库再打 tag，不能在私有仓库里跑。
 */
async function identityRepositoryFixture(version: string) {
  const root = await mkdtemp(join(tmpdir(), "adrate-identity-step-"))
  const outputRoot = await mkdtemp(join(tmpdir(), "adrate-identity-output-"))
  roots.push(root, outputRoot)
  await mkdir(join(root, "scripts"))
  for (const script of [
    "release-gate.mjs",
    "public-mirror.mjs",
    "secret-patterns.mjs",
  ]) {
    await copyFile(
      join(CLI_ROOT, "scripts", script),
      join(root, "scripts", script)
    )
  }
  const packageJson = JSON.parse(
    await readFile(join(CLI_ROOT, "package.json"), "utf8")
  ) as Record<string, unknown>
  packageJson.version = version
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`
  )
  await execFileAsync("git", ["init", "--initial-branch=main", root])
  await execFileAsync("git", [
    "-C",
    root,
    "config",
    "user.email",
    "test@adrate.local",
  ])
  await execFileAsync("git", ["-C", root, "config", "user.name", "AdRate Test"])
  await execFileAsync("git", ["-C", root, "add", "."])
  await execFileAsync("git", ["-C", root, "commit", "-m", `release ${version}`])
  await execFileAsync("git", ["-C", root, "tag", `v${version}`])
  const commit = (
    await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])
  ).stdout.trim()
  return { root, commit, outputPath: join(outputRoot, "github-output.txt") }
}

/** 从真实 workflow 里取出 identity 步骤的 run 命令，测试不自己拼 argv。 */
function identityStepCommand(workflow: string) {
  const commands = workflow
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      line.startsWith("run: node scripts/release-gate.mjs --identity")
    )
  expect(commands).toHaveLength(1)
  return commands[0]!.slice("run: ".length)
}

/** 只解析 workflow 里这一处 GitHub 表达式，解析后禁止残留任何 `${{ }}`。 */
function resolveWorkflowExpressions(command: string, refName: string) {
  const channelExpression =
    "${{ contains(github.ref_name, '-') && 'prerelease' || 'stable' }}"
  expect(command).toContain(channelExpression)
  const resolved = command.replaceAll(
    channelExpression,
    refName.includes("-") ? "prerelease" : "stable"
  )
  expect(resolved.includes("${{")).toBe(false)
  return resolved
}

async function runIdentityStep(
  command: string,
  fixture: { root: string; commit: string; outputPath: string },
  refName: string
) {
  await writeFile(fixture.outputPath, "")
  const result = await execFileAsync("bash", ["-c", command], {
    cwd: fixture.root,
    env: {
      ...process.env,
      GITHUB_REF_NAME: refName,
      GITHUB_SHA: fixture.commit,
      GITHUB_OUTPUT: fixture.outputPath,
    },
  })
  return { ...result, output: await readFile(fixture.outputPath, "utf8") }
}

describe("publish workflow identity step", () => {
  it("以 workflow 真实 argv 跑通 stable 与 prerelease 两条 tag 身份", async () => {
    const workflow = await readFile(
      join(CLI_ROOT, ".github/workflows/publish.yml"),
      "utf8"
    )
    const command = identityStepCommand(workflow)
    // 具名闭世界子串：漏传 --channel 时 release-gate 会给出明确失败原因。
    expect(
      workflow.split(
        'node scripts/release-gate.mjs --identity --tag "$GITHUB_REF_NAME" --commit "$GITHUB_SHA" --channel '
      ).length - 1
    ).toBe(1)

    const stable = await identityRepositoryFixture("0.1.0")
    const stableRun = await runIdentityStep(
      resolveWorkflowExpressions(command, "v0.1.0"),
      stable,
      "v0.1.0"
    )
    expect(stableRun.stderr).toBe("")
    expect(stableRun.output).toBe(
      "version=0.1.0\nchannel=stable\ndist-tag=latest\n"
    )

    const prerelease = await identityRepositoryFixture("0.1.0-beta.1")
    const prereleaseRun = await runIdentityStep(
      resolveWorkflowExpressions(command, "v0.1.0-beta.1"),
      prerelease,
      "v0.1.0-beta.1"
    )
    expect(prereleaseRun.stderr).toBe("")
    expect(prereleaseRun.output).toBe(
      "version=0.1.0-beta.1\nchannel=prerelease\ndist-tag=next\n"
    )
  }, 30_000)

  it("回归钉死漏传 --channel 与 channel/version 矛盾都必须 exit 1", async () => {
    const workflow = await readFile(
      join(CLI_ROOT, ".github/workflows/publish.yml"),
      "utf8"
    )
    const resolved = resolveWorkflowExpressions(
      identityStepCommand(workflow),
      "v0.1.0"
    )
    const fixture = await identityRepositoryFixture("0.1.0")

    // 修复前的 argv：identity 模式要求 tag/commit/channel 三者同时提供。
    const withoutChannel = resolved.replace(/ --channel "[^"]*"/, "")
    expect(withoutChannel).not.toContain("--channel")
    await expect(
      runIdentityStep(withoutChannel, fixture, "v0.1.0")
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        "Release tag, commit, and channel must be supplied together."
      ),
    })

    // channel 是对 package.json 版本的交叉校验，矛盾值不得被采纳。
    await expect(
      runIdentityStep(
        resolved.replace(/ --channel "[^"]*"/, ' --channel "prerelease"'),
        fixture,
        "v0.1.0"
      )
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        "Release channel does not match the package version."
      ),
    })
  }, 30_000)
})

describe("channel readiness and evidence", () => {
  it("freezes exactly nine IDs and rejects missing, replacement, and duplicate IDs", async () => {
    const readiness = await readinessFixture()
    expect(EXTERNAL_GATE_IDS).toStrictEqual([
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
    // M0 不含 Accio connector：两项 accio gate 保留在九项名册里并维持 blocked，
    // 但不属于任何 channel 的 required 列表。两个列表同样精确 pin，防止悄悄增删。
    expect(PRERELEASE_GATE_IDS).toStrictEqual([
      "github-public-mirror",
      "npm-bootstrap-and-2fa",
      "npm-trusted-publisher",
      "openresty-test",
    ])
    expect(STABLE_GATE_IDS).toStrictEqual([
      "github-public-mirror",
      "npm-bootstrap-and-2fa",
      "npm-trusted-publisher",
      "openresty-test",
      "openresty-production",
      "real-cli-e2e",
      "windows-hardware",
    ])
    for (const id of ["accio-official-connector", "accio-capacity"]) {
      expect(PRERELEASE_GATE_IDS).not.toContain(id)
      expect(STABLE_GATE_IDS).not.toContain(id)
      expect(readiness.gates.find((gate: any) => gate.id === id).status).toBe(
        "blocked"
      )
    }
    expect(() => validateExternalReadinessDocument(readiness)).not.toThrow()

    const missing = clone(readiness)
    missing.gates.pop()
    expect(() => validateExternalReadinessDocument(missing)).toThrow()
    const replaced = clone(readiness)
    replaced.gates[2].id = "unknown-gate"
    expect(() => validateExternalReadinessDocument(replaced)).toThrow()
    const duplicate = clone(readiness)
    duplicate.gates[2].id = duplicate.gates[1].id
    expect(() => validateExternalReadinessDocument(duplicate)).toThrow()
  })

  it("allows prerelease readiness while all stable-only gates remain blocked", async () => {
    const readiness = makePrereleasePassing(await readinessFixture())
    expect(() => validateExternalReadinessDocument(readiness)).not.toThrow()
    expect(readiness.channels.prerelease.status).toBe("pass")
    expect(readiness.channels.stable.status).toBe("blocked")
    for (const id of EXTERNAL_GATE_IDS.filter(
      (gateId) => !PRERELEASE_GATE_IDS.includes(gateId)
    )) {
      expect(readiness.gates.find((gate: any) => gate.id === id).status).toBe(
        "blocked"
      )
    }
  })

  it("freezes the independent trusted-pin document to exactly nine IDs", async () => {
    const document = JSON.parse(
      await readFile(
        join(CLI_ROOT, "release/trusted-evidence-pins.json"),
        "utf8"
      )
    ) as Record<string, any>
    expect(() => validateTrustedEvidencePinsDocument(document)).not.toThrow()
    await expect(verifyTrustedEvidencePins(CLI_ROOT)).resolves.toEqual(
      document.pins
    )

    const missing = clone(document)
    delete missing.pins[EXTERNAL_GATE_IDS[0]!]
    expect(() => validateTrustedEvidencePinsDocument(missing)).toThrow(
      "frozen schema"
    )
    const replaced = clone(document)
    delete replaced.pins[EXTERNAL_GATE_IDS[1]!]
    replaced.pins["unreviewed-gate"] = null
    expect(() => validateTrustedEvidencePinsDocument(replaced)).toThrow(
      "frozen schema"
    )
    const extra = clone(document)
    extra.pins["unreviewed-gate"] = null
    expect(() => validateTrustedEvidencePinsDocument(extra)).toThrow(
      "frozen schema"
    )
    const malformed = clone(document)
    malformed.pins[EXTERNAL_GATE_IDS[0]!] = {
      sha256: "not-a-digest",
      issuer: "review board with spaces",
      environment: "wrong-environment",
    }
    expect(() => validateTrustedEvidencePinsDocument(malformed)).toThrow(
      "pin is invalid"
    )

    const root = await mkdtemp(join(tmpdir(), "adrate-trusted-pins-"))
    roots.push(root)
    await mkdir(join(root, "release"))
    await writeFile(
      join(root, "release/trusted-evidence-pins.json"),
      `${JSON.stringify(missing)}\n`
    )
    await expect(verifyTrustedEvidencePins(root)).rejects.toThrow(
      "frozen schema"
    )
  })

  it("rejects editable pass claims without reviewed pins and rejects forged evidence", async () => {
    const fixture = await evidenceFixture({ reviewedPins: false })
    await expect(
      verifyExternalReadinessEvidence({
        root: fixture.root,
        readiness: fixture.readiness,
        channel: "prerelease",
        version: "0.1.0-beta.1",
        commit: fixture.currentCommit,
        currentArtifactSha256: "b".repeat(64),
      })
    ).rejects.toThrow("no reviewed trust pin")

    const selfSigned = await evidenceFixture({ selfSigned: true })
    await expect(
      verifyExternalReadinessEvidence({
        ...selfSigned,
        channel: "prerelease",
        version: "0.1.0-beta.1",
        commit: selfSigned.currentCommit,
        currentArtifactSha256: "b".repeat(64),
      })
    ).rejects.toThrow("content is not trusted")

    const tampered = await evidenceFixture()
    await writeFile(
      join(tampered.root, `release/evidence/${PRERELEASE_GATE_IDS[0]}.json`),
      "digest drift\n"
    )
    await expect(
      verifyExternalReadinessEvidence({
        root: tampered.root,
        readiness: tampered.readiness,
        channel: "prerelease",
        version: "0.1.0-beta.1",
        commit: tampered.currentCommit,
        currentArtifactSha256: "b".repeat(64),
      })
    ).rejects.toThrow("digest drifted")
  })

  // 摘掉 accio 硬失败之前，prerelease 证据校验永远在最后一步被拦下，整条链的
  // happy path 从未真正跑通过。这条正向测试确保后续步骤是真的能过，而不是一直
  // 被 accio 挡着看不出坏。
  it("accepts a fully reviewed prerelease evidence set now that Accio is not required", async () => {
    const fixture = await evidenceFixture()
    await expect(
      verifyExternalReadinessEvidence({
        root: fixture.root,
        readiness: fixture.readiness,
        channel: "prerelease",
        version: "0.1.0-beta.1",
        commit: fixture.currentCommit,
        currentArtifactSha256: "b".repeat(64),
      })
    ).resolves.toBeUndefined()
  })

  it("rejects readiness that smuggles a non-required gate back into a channel", async () => {
    const smuggled = await readinessFixture()
    smuggled.channels.prerelease.requiredGateIds = [
      ...smuggled.channels.prerelease.requiredGateIds,
      "accio-official-connector",
    ]
    expect(() => validateExternalReadinessDocument(smuggled)).toThrow(
      "prerelease channel contract drifted"
    )
  })
})

describe("release identity and npm monotonicity", () => {
  it("binds prerelease evidence to an ancestor-tested identical artifact", () => {
    const base = {
      channel: "prerelease" as const,
      currentVersion: "1.2.3-rc.2",
      currentCommit: "b".repeat(40),
      currentArtifactSha256: "c".repeat(64),
      evidence: {
        releaseTrain: "1.2.3",
        validatedCommit: "a".repeat(40),
        testedVersion: "1.2.3-rc.2",
        testedCommit: "a".repeat(40),
        tarballSha256: "c".repeat(64),
      },
      validatedCommitIsAncestor: true,
      testedCommitIsAncestor: true,
      runtimeCompatible: true,
    }
    expect(() => validateReleaseTrainEvidenceBinding(base)).not.toThrow()
    expect(() =>
      validateReleaseTrainEvidenceBinding({
        ...base,
        currentArtifactSha256: "d".repeat(64),
      })
    ).toThrow("tested immutable artifact")
    expect(() =>
      validateReleaseTrainEvidenceBinding({
        ...base,
        testedCommitIsAncestor: false,
      })
    ).toThrow("release train ancestry")
    expect(() =>
      validateReleaseTrainEvidenceBinding({ ...base, runtimeCompatible: false })
    ).toThrow("tested immutable artifact")
    expect(() =>
      validateReleaseTrainEvidenceBinding({
        ...base,
        evidence: { ...base.evidence, releaseTrain: "1.2.4" },
      })
    ).toThrow("release train ancestry")
  })

  it("accepts only same-train ancestor prerelease evidence without runtime drift", () => {
    const base = {
      channel: "stable" as const,
      currentVersion: "1.2.3",
      currentCommit: "b".repeat(40),
      currentArtifactSha256: "c".repeat(64),
      evidence: {
        releaseTrain: "1.2.3",
        validatedCommit: "a".repeat(40),
        testedVersion: "1.2.3-rc.1",
        testedCommit: "a".repeat(40),
        tarballSha256: "d".repeat(64),
      },
      validatedCommitIsAncestor: true,
      testedCommitIsAncestor: true,
      runtimeCompatible: true,
    }
    expect(() => validateReleaseTrainEvidenceBinding(base)).not.toThrow()
    expect(() =>
      validateReleaseTrainEvidenceBinding({
        ...base,
        evidence: { ...base.evidence, releaseTrain: "1.2.4" },
      })
    ).toThrow("release train")
    expect(() =>
      validateReleaseTrainEvidenceBinding({
        ...base,
        testedCommitIsAncestor: false,
      })
    ).toThrow("release train ancestry")
    expect(() =>
      validateReleaseTrainEvidenceBinding({ ...base, runtimeCompatible: false })
    ).toThrow("runtime-identical prerelease")
  })

  it("allows only exact release metadata drift after the tested candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "adrate-release-train-"))
    roots.push(root)
    await execFileAsync("git", ["init", "--initial-branch=main", root])
    await execFileAsync("git", [
      "-C",
      root,
      "config",
      "user.email",
      "test@adrate.local",
    ])
    await execFileAsync("git", [
      "-C",
      root,
      "config",
      "user.name",
      "AdRate Test",
    ])
    await mkdir(join(root, "src"))
    await writeFile(
      join(root, "package.json"),
      '{"name":"@adrate/cli","version":"1.2.3-rc.1"}\n'
    )
    await writeFile(join(root, "src/runtime.ts"), "export const value = 1\n")
    await execFileAsync("git", ["-C", root, "add", "."])
    await execFileAsync("git", ["-C", root, "commit", "-m", "prerelease"])
    const tested = (
      await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])
    ).stdout.trim()

    const allowedFiles = [
      ".adrate-public-mirror.json",
      "release/external-readiness.json",
      "release/trusted-evidence-pins.json",
      "release/README.md",
      "release/RELEASE_NOTES-0.1.0.md",
      ...EXTERNAL_GATE_IDS.map((id) => `release/evidence/${id}.json`),
    ]
    const writeAllowedFiles = async () => {
      for (const path of allowedFiles) {
        await mkdir(dirname(join(root, path)), { recursive: true })
        await writeFile(join(root, path), `${path}\n`)
      }
    }
    const commitAll = async (message: string) => {
      await execFileAsync("git", ["-C", root, "add", "."])
      await execFileAsync("git", ["-C", root, "commit", "-m", message])
      return (
        await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])
      ).stdout.trim()
    }

    await execFileAsync("git", [
      "-C",
      root,
      "checkout",
      "-b",
      "prerelease-metadata",
      tested,
    ])
    await writeAllowedFiles()
    const prereleaseMetadata = await commitAll("prerelease metadata")
    await expect(
      assertPrereleaseRuntimeCompatibility(root, tested, prereleaseMetadata)
    ).resolves.toBeUndefined()

    await execFileAsync("git", [
      "-C",
      root,
      "checkout",
      "-b",
      "stable-metadata",
      tested,
    ])
    await writeFile(
      join(root, "package.json"),
      '{"name":"@adrate/cli","version":"1.2.3"}\n'
    )
    await writeAllowedFiles()
    const stable = await commitAll("stable metadata")
    await expect(
      assertStableRuntimeCompatibility(root, tested, stable)
    ).resolves.toBeUndefined()
    await expect(
      assertPrereleaseRuntimeCompatibility(root, tested, stable)
    ).rejects.toThrow("package.json changed")

    for (const [index, path] of [
      "scripts/release-gate.mjs",
      "scripts/release-gate.d.mts",
      "test/release-gate.test.ts",
    ].entries()) {
      await execFileAsync("git", [
        "-C",
        root,
        "checkout",
        "-b",
        `verifier-drift-${index}`,
        tested,
      ])
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), "verifier drift\n")
      const verifierDrift = await commitAll(`verifier drift ${index}`)
      await expect(
        assertPrereleaseRuntimeCompatibility(root, tested, verifierDrift)
      ).rejects.toThrow(path)
      await expect(
        assertStableRuntimeCompatibility(root, tested, verifierDrift)
      ).rejects.toThrow(path)
    }

    await execFileAsync("git", [
      "-C",
      root,
      "checkout",
      "-b",
      "package-drift",
      tested,
    ])
    await writeFile(
      join(root, "package.json"),
      '{"name":"@attacker/cli","version":"1.2.3"}\n'
    )
    const packageDrift = await commitAll("package drift")
    await expect(
      assertStableRuntimeCompatibility(root, tested, packageDrift)
    ).rejects.toThrow("beyond its version")

    await execFileAsync("git", [
      "-C",
      root,
      "checkout",
      "-b",
      "runtime-drift",
      tested,
    ])
    await writeFile(join(root, "src/runtime.ts"), "export const value = 2\n")
    const runtimeDrift = await commitAll("runtime drift")
    await expect(
      assertStableRuntimeCompatibility(root, tested, runtimeDrift)
    ).rejects.toThrow("runtime drifted")
    await expect(
      assertPrereleaseRuntimeCompatibility(root, tested, runtimeDrift)
    ).rejects.toThrow("runtime drifted")

    await execFileAsync("git", [
      "-C",
      root,
      "checkout",
      "-b",
      "unrelated",
      tested,
    ])
    await writeFile(join(root, "release-review.md"), "unrelated\n")
    const unrelatedCommit = await commitAll("unrelated")
    await expect(
      assertStableRuntimeCompatibility(root, unrelatedCommit, stable)
    ).rejects.toThrow("not an ancestor")
  })

  it("rejects tag/version/channel inconsistencies", () => {
    expect(() =>
      validateReleaseIdentity({
        version: "0.2.0-beta.1",
        tag: "v0.2.0-beta.1",
        commit: "a".repeat(40),
        channel: "stable",
      })
    ).toThrow("channel")
    expect(() =>
      validateReleaseIdentity({
        version: "0.2.0",
        tag: "v0.2.1",
        commit: "a".repeat(40),
        channel: "stable",
      })
    ).toThrow("Git tag")
  })

  it("rejects a tag that dereferences to a different commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "adrate-tag-identity-"))
    roots.push(root)
    await execFileAsync("git", ["init", "--initial-branch=main", root])
    await execFileAsync("git", [
      "-C",
      root,
      "config",
      "user.email",
      "test@adrate.local",
    ])
    await execFileAsync("git", [
      "-C",
      root,
      "config",
      "user.name",
      "AdRate Test",
    ])
    await writeFile(join(root, "file"), "one")
    await execFileAsync("git", ["-C", root, "add", "file"])
    await execFileAsync("git", ["-C", root, "commit", "-m", "one"])
    await execFileAsync("git", ["-C", root, "tag", "v1.0.0"])
    await writeFile(join(root, "file"), "two")
    await execFileAsync("git", ["-C", root, "commit", "-am", "two"])
    const head = (
      await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])
    ).stdout.trim()

    await expect(
      assertReleaseGitIdentity(root, {
        version: "1.0.0",
        tag: "v1.0.0",
        commit: head,
        channel: "stable",
      })
    ).rejects.toThrow("does not dereference to release HEAD")
  })

  it("fails closed on latest/next rollback, invalid registry data, and outages", () => {
    expect(() =>
      assertRegistryMonotonicResponse("1.2.0-beta.2", "prerelease", {
        status: 200,
        text: '{"next":"1.2.0-beta.1"}',
      })
    ).not.toThrow()
    expect(() =>
      assertRegistryMonotonicResponse("1.2.0-beta.1", "prerelease", {
        status: 200,
        text: '{"latest":"1.1.0"}',
      })
    ).not.toThrow()
    expect(() =>
      assertRegistryMonotonicResponse("1.2.0-beta.1", "prerelease", {
        status: 200,
        text: '{"next":"1.2.0-beta.2"}',
      })
    ).toThrow("roll back or repeat")
    expect(() =>
      assertRegistryMonotonicResponse("1.2.0", "stable", {
        status: 200,
        text: '{"latest":"1.3.0"}',
      })
    ).toThrow("roll back or repeat")
    expect(() =>
      assertRegistryMonotonicResponse("1.2.0", "stable", {
        status: 404,
        text: "",
      })
    ).toThrow("failed closed")
    expect(() =>
      assertRegistryMonotonicResponse("1.2.0", "stable", {
        status: 503,
        text: "unavailable",
      })
    ).toThrow("failed closed")
    expect(() =>
      assertRegistryMonotonicResponse("1.2.0", "stable", {
        status: 200,
        text: "not-json",
      })
    ).toThrow("not JSON")
    expect(() =>
      assertRegistryMonotonicResponse("1.2.0", "stable", {
        status: 200,
        text: '{"latest":{"version":"1.1.0"}}',
      })
    ).toThrow("not strict SemVer")
    expect(() =>
      assertRegistryMonotonicResponse(
        "999999999999999999999999999999.0.0",
        "stable",
        {
          status: 200,
          text: '{"latest":"999999999999999999999999999998.9.9"}',
        }
      )
    ).not.toThrow()
  })
})
