import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../src/runner.js"
import { createCliRuntime } from "../src/runtime.js"
import { CredentialStore } from "../src/storage/credential-backend.js"
import type {
  CredentialAddress,
  CredentialBackend,
} from "../src/storage/credential-backend.js"
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from "../src/http/client.js"
import type { AcknowledgedOutputStream } from "../src/output.js"
import type { TokenStorageKind } from "../src/storage/schemas.js"
import type {
  UpdateRegistryRequest,
  UpdateRegistryTransport,
} from "../src/notices/update-notifier.js"

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url))
const roots: Array<string> = []

class RejectingCredentialBackend implements CredentialBackend {
  reads = 0
  writes = 0
  removes = 0
  availabilityChecks = 0

  constructor(readonly kind: TokenStorageKind) {}

  isAvailable(): Promise<boolean> {
    this.availabilityChecks += 1
    return Promise.reject(
      new Error("Skills command touched credential availability")
    )
  }

  read(_address: CredentialAddress): Promise<string | null> {
    this.reads += 1
    return Promise.reject(new Error("Skills command touched credential read"))
  }

  write(_address: CredentialAddress, _token: string): Promise<void> {
    this.writes += 1
    return Promise.reject(new Error("Skills command touched credential write"))
  }

  remove(_address: CredentialAddress): Promise<void> {
    this.removes += 1
    return Promise.reject(new Error("Skills command touched credential remove"))
  }
}

class RejectingTransport implements HttpTransport {
  requests = 0

  request(_input: HttpRequest): Promise<HttpResponse> {
    this.requests += 1
    return Promise.reject(new Error("Skills command touched HTTP transport"))
  }
}

class CaptureStream implements AcknowledgedOutputStream {
  value = ""

  write(value: string, callback: (error?: Error | null) => void): boolean {
    this.value += value
    queueMicrotask(() => callback())
    return true
  }
}

class CountingUpdateTransport implements UpdateRegistryTransport {
  requests: Array<UpdateRegistryRequest> = []

  request(input: UpdateRegistryRequest) {
    this.requests.push(input)
    return Promise.resolve({ status: 200, text: '{"version":"0.1.0"}' })
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("production runtime Skills entry", () => {
  it("runs JSON list and raw read with zero credential and HTTP operations", async () => {
    const root = await mkdtemp(join(tmpdir(), "adrate-skills-runtime-"))
    roots.push(root)
    const installed = join(root, "installed")
    await mkdir(installed)
    for (const name of ["adrate-shared", "adrate-ads"]) {
      await cp(join(CLI_ROOT, "skills", name), join(installed, name), {
        recursive: true,
      })
    }
    const keychain = new RejectingCredentialBackend("keychain")
    const fallback = new RejectingCredentialBackend("fallback_file")
    const transport = new RejectingTransport()
    const runtime = createCliRuntime({
      root: join(root, "state"),
      packageRoot: CLI_ROOT,
      installedSkillsRoot: installed,
      credentialStore: new CredentialStore(keychain, fallback),
      transport,
      environment: { ADRATE_NO_UPDATE_NOTIFIER: "1" },
      progress: () => undefined,
    })

    const listStdout = new CaptureStream()
    const listStderr = new CaptureStream()
    await expect(
      runCli(runtime.application, ["skills", "list", "--json"], {
        stdout: listStdout,
        stderr: listStderr,
      })
    ).resolves.toBe(0)
    const listEnvelope = JSON.parse(listStdout.value) as {
      ok: boolean
      data: { skills: Array<{ name: string }> }
    }
    expect(listEnvelope.ok).toBe(true)
    expect(listEnvelope.data.skills.map((skill) => skill.name)).toStrictEqual([
      "adrate-ads",
      "adrate-shared",
    ])
    expect(listStdout.value.trim().split("\n")).toHaveLength(1)
    expect(listStderr.value).toBe("")

    const readStdout = new CaptureStream()
    const readStderr = new CaptureStream()
    await expect(
      runCli(runtime.application, ["skills", "read", "adrate-ads"], {
        stdout: readStdout,
        stderr: readStderr,
      })
    ).resolves.toBe(0)
    expect(readStdout.value).toContain("# AdRate Ads Operations Contract")
    expect(readStdout.value).toMatch(/[^\n]\n$/)
    expect(readStderr.value).toBe("")

    expect(transport.requests).toBe(0)
    for (const backend of [keychain, fallback]) {
      expect(backend.availabilityChecks).toBe(0)
      expect(backend.reads).toBe(0)
      expect(backend.writes).toBe(0)
      expect(backend.removes).toBe(0)
    }
  })

  it("lets only the update notifier network after list and keeps read fully local", async () => {
    const root = await mkdtemp(join(tmpdir(), "adrate-skills-update-runtime-"))
    roots.push(root)
    const installed = join(root, "installed")
    await mkdir(installed)
    for (const name of ["adrate-shared", "adrate-ads"]) {
      await cp(join(CLI_ROOT, "skills", name), join(installed, name), {
        recursive: true,
      })
    }
    const apiTransport = new RejectingTransport()
    const updateTransport = new CountingUpdateTransport()
    const runtime = createCliRuntime({
      root: join(root, "state"),
      packageRoot: CLI_ROOT,
      installedSkillsRoot: installed,
      credentialStore: new CredentialStore(
        new RejectingCredentialBackend("keychain"),
        new RejectingCredentialBackend("fallback_file")
      ),
      transport: apiTransport,
      updateTransport,
      environment: {},
      progress: () => undefined,
    })

    await expect(
      runCli(runtime.application, ["skills", "list", "--json"], {
        stdout: new CaptureStream(),
        stderr: new CaptureStream(),
      })
    ).resolves.toBe(0)
    expect(apiTransport.requests).toBe(0)
    expect(updateTransport.requests).toHaveLength(1)
    expect(updateTransport.requests[0]).toMatchObject({
      url: "https://registry.npmjs.org/@adrate%2Fcli/latest",
      headers: { accept: "application/json" },
    })

    await expect(
      runCli(runtime.application, ["skills", "read", "adrate-shared"], {
        stdout: new CaptureStream(),
        stderr: new CaptureStream(),
      })
    ).resolves.toBe(0)
    expect(apiTransport.requests).toBe(0)
    expect(updateTransport.requests).toHaveLength(1)
  })
})
