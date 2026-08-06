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
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import {
  assertReleaseGitIdentity,
  validateReleaseIdentity,
} from "../scripts/release-gate.mjs"

const execFileAsync = promisify(execFile)
const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url))
const roots: Array<string> = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("release gate", () => {
  it("publish job 只校验 release identity 与 tarball 总摘要", async () => {
    const workflow = await readFile(
      join(CLI_ROOT, ".github/workflows/publish.yml"),
      "utf8"
    )
    const publishJob = workflow.slice(workflow.indexOf("  publish:"))
    expect(publishJob).toContain("release-artifact.json")
    expect(publishJob).toContain('createHash("sha256")')
    expect(publishJob).toContain("manifest.sha256")
    expect(publishJob).not.toContain("expectedFiles")
    expect(publishJob).not.toContain("execFileSync")
    expect(publishJob).not.toContain('["-tzf"')
    expect(publishJob).not.toContain('["-xOzf"')
    expect(publishJob).not.toContain("sourcesContent")
  })

  it("passes the local supply-chain checks", async () => {
    const result = await execFileAsync(
      process.execPath,
      ["scripts/release-gate.mjs", "--local"],
      { cwd: CLI_ROOT, maxBuffer: 4 * 1024 * 1024 }
    )
    expect(result.stdout).toBe("Local release gate PASS\n")
    expect(result.stderr).toBe("")
  }, 60_000)
})

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

describe("release identity", () => {
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
})
