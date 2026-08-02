import { Agent, Headers, fetch } from "undici"
import { CLI_VERSION } from "../constants.js"
import {
  hasExactKeys,
  isCanonicalUtcIso,
  isPlainObject,
} from "../contracts/json.js"
import { compareSemver, isValidSemver } from "../skills/skill-contract.js"
import { replaceLocalNotice } from "./notice-merge.js"
import type { CliEnvelope } from "../contracts/envelope.js"
import type { JsonObject } from "../contracts/json.js"
import type { CliOutcome } from "../errors.js"
import type { SecureFileSystem } from "../storage/secure-files.js"
import type { CliPaths } from "../storage/paths.js"
import type { Response as UndiciResponse } from "undici"

export const UPDATE_REGISTRY_URL =
  "https://registry.npmjs.org/@adrate%2Fcli/latest" as const
export const UPDATE_REGISTRY_TIMEOUT_MS = 2_000 as const
export const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1_000
export const UPDATE_REGISTRY_MAX_BYTES = 64 * 1_024

export interface UpdateRegistryRequest {
  url: string
  deadlineMs: number
  maxResponseBytes: number
  headers: Readonly<Record<string, string>>
}

export type UpdateFetch = typeof fetch

export interface UpdateRegistryResponse {
  status: number
  text: string
}

export interface UpdateRegistryTransport {
  request: (input: UpdateRegistryRequest) => Promise<UpdateRegistryResponse>
}

export interface UpdateNotice {
  level: "info"
  currentVersion: string
  latestVersion: string
  checkedAt: string
  suggestedAction: "upgrade_cli"
  command: "npm install -g @adrate/cli"
}

export interface UpdateNotifierInspection {
  notice: UpdateNotice | null
  warning: string | null
  diagnostic: string | null
}

interface UpdateCache {
  formatVersion: 1
  latestVersion: string
  checkedAt: string
}

type CacheInspection =
  | { state: "missing" }
  | { state: "corrupt" }
  | { state: "fresh" | "stale"; cache: UpdateCache }

class UpdateRegistryError extends Error {
  constructor(readonly kind: "timeout" | "network" | "invalid_response") {
    super(kind)
    this.name = "UpdateRegistryError"
  }
}

async function readBoundedText(
  response: UndiciResponse,
  maximumBytes: number
): Promise<string> {
  const declaredLength = response.headers.get("content-length")
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > maximumBytes
  ) {
    await response.body?.cancel()
    throw new UpdateRegistryError("invalid_response")
  }
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > maximumBytes) {
        await reader.cancel()
        throw new UpdateRegistryError("invalid_response")
      }
      chunks.push(result.value)
    }
  } catch (error) {
    if (error instanceof UpdateRegistryError) throw error
    throw new UpdateRegistryError("network")
  }
  const merged = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(merged)
  } catch {
    throw new UpdateRegistryError("invalid_response")
  }
}

export class DefaultUpdateRegistryTransport implements UpdateRegistryTransport {
  constructor(private readonly requestUrl: UpdateFetch = fetch) {}

  async request(input: UpdateRegistryRequest): Promise<UpdateRegistryResponse> {
    if (
      input.url !== UPDATE_REGISTRY_URL ||
      input.deadlineMs !== UPDATE_REGISTRY_TIMEOUT_MS ||
      input.maxResponseBytes !== UPDATE_REGISTRY_MAX_BYTES ||
      Object.keys(input.headers).length !== 1 ||
      input.headers.accept !== "application/json"
    ) {
      throw new UpdateRegistryError("invalid_response")
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), input.deadlineMs)
    timeout.unref()
    const dispatcher = new Agent({
      connect: { timeout: input.deadlineMs },
    })
    try {
      const response = await this.requestUrl(input.url, {
        method: "GET",
        headers: new Headers(input.headers),
        redirect: "manual",
        signal: controller.signal,
        dispatcher,
      })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        throw new UpdateRegistryError("invalid_response")
      }
      return {
        status: response.status,
        text: await readBoundedText(response, input.maxResponseBytes),
      }
    } catch (error) {
      if (error instanceof UpdateRegistryError) throw error
      if (
        controller.signal.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw new UpdateRegistryError("timeout")
      }
      throw new UpdateRegistryError("network")
    } finally {
      clearTimeout(timeout)
      await dispatcher.destroy().catch(() => undefined)
    }
  }
}

function parseCache(text: string): UpdateCache | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["formatVersion", "latestVersion", "checkedAt"]) ||
    value.formatVersion !== 1 ||
    !isValidSemver(value.latestVersion) ||
    !isCanonicalUtcIso(value.checkedAt)
  ) {
    return null
  }
  return {
    formatVersion: 1,
    latestVersion: value.latestVersion,
    checkedAt: value.checkedAt,
  }
}

function parseLatestVersion(text: string): string | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  return isPlainObject(value) && isValidSemver(value.version)
    ? value.version
    : null
}

function asNoticeObject(notice: UpdateNotice): JsonObject {
  return notice as unknown as JsonObject
}

function noUpdate(diagnostic: string | null = null): UpdateNotifierInspection {
  return { notice: null, warning: null, diagnostic }
}

export function withUpdateNotifierInspection<TEnvelope extends CliEnvelope>(
  outcome: CliOutcome<TEnvelope>,
  inspection: UpdateNotifierInspection,
  verbose: boolean
): CliOutcome<CliEnvelope> {
  const warnings = [...outcome.warnings]
  if (inspection.warning) warnings.push(inspection.warning)
  if (verbose && inspection.diagnostic) warnings.push(inspection.diagnostic)
  return {
    ...outcome,
    envelope: replaceLocalNotice(
      outcome.envelope,
      "update",
      inspection.notice ? asNoticeObject(inspection.notice) : null
    ),
    warnings,
  }
}

export class UpdateNotifier {
  private readonly now: () => Date
  private readonly transport: UpdateRegistryTransport

  constructor(
    private readonly options: {
      fileSystem: SecureFileSystem
      paths: CliPaths
      environment: NodeJS.ProcessEnv
      now?: () => Date
      transport?: UpdateRegistryTransport
    }
  ) {
    this.now = options.now ?? (() => new Date())
    this.transport = options.transport ?? new DefaultUpdateRegistryTransport()
  }

  private async cacheInspection(nowMs: number): Promise<CacheInspection> {
    const text = await this.options.fileSystem.readSecureFile(
      this.options.paths.updateCache
    )
    if (text === null) return { state: "missing" }
    const cache = parseCache(text)
    if (!cache) return { state: "corrupt" }
    const age = nowMs - new Date(cache.checkedAt).getTime()
    return {
      state: age >= 0 && age < UPDATE_CACHE_TTL_MS ? "fresh" : "stale",
      cache,
    }
  }

  private inspectionFor(cache: UpdateCache): UpdateNotifierInspection {
    if (compareSemver(cache.latestVersion, CLI_VERSION) <= 0) {
      return noUpdate()
    }
    const notice: UpdateNotice = {
      level: "info",
      currentVersion: CLI_VERSION,
      latestVersion: cache.latestVersion,
      checkedAt: cache.checkedAt,
      suggestedAction: "upgrade_cli",
      command: "npm install -g @adrate/cli",
    }
    return {
      notice,
      warning: `AdRate CLI ${cache.latestVersion} is available (current ${CLI_VERSION}). Run: ${notice.command}`,
      diagnostic: null,
    }
  }

  private async fetchLatest(): Promise<string> {
    const response = await this.transport.request({
      url: UPDATE_REGISTRY_URL,
      deadlineMs: UPDATE_REGISTRY_TIMEOUT_MS,
      maxResponseBytes: UPDATE_REGISTRY_MAX_BYTES,
      headers: Object.freeze({ accept: "application/json" }),
    })
    if (response.status < 200 || response.status >= 300) {
      throw new UpdateRegistryError("invalid_response")
    }
    const version = parseLatestVersion(response.text)
    if (!version) throw new UpdateRegistryError("invalid_response")
    return version
  }

  async inspect(): Promise<UpdateNotifierInspection> {
    if (this.options.environment.ADRATE_NO_UPDATE_NOTIFIER === "1") {
      return noUpdate()
    }
    const startedAt = this.now()
    let initial: CacheInspection
    try {
      initial = await this.cacheInspection(startedAt.getTime())
    } catch {
      return noUpdate(
        "Update check skipped because the local update cache is unsafe."
      )
    }
    if (initial.state === "corrupt") {
      return noUpdate(
        "Update check skipped because the local update cache is invalid."
      )
    }
    if (initial.state === "fresh") return this.inspectionFor(initial.cache)

    let latestVersion: string
    try {
      latestVersion = await this.fetchLatest()
    } catch (error) {
      const reason =
        error instanceof UpdateRegistryError ? error.kind : "network"
      return noUpdate(`Update check skipped after a ${reason} failure.`)
    }

    try {
      return await this.options.fileSystem.withLock(
        this.options.paths.updateCacheLock,
        async () => {
          const checkedAt = this.now()
          const concurrent = await this.cacheInspection(checkedAt.getTime())
          if (concurrent.state === "corrupt") {
            return noUpdate(
              "Update check skipped because the local update cache is invalid."
            )
          }
          if (concurrent.state === "fresh") {
            return this.inspectionFor(concurrent.cache)
          }
          const cache: UpdateCache = {
            formatVersion: 1,
            latestVersion,
            checkedAt: checkedAt.toISOString(),
          }
          await this.options.fileSystem.atomicWrite(
            this.options.paths.updateCache,
            `${JSON.stringify(cache, null, 2)}\n`
          )
          return this.inspectionFor(cache)
        }
      )
    } catch {
      return noUpdate(
        "Update check skipped because the local update cache could not be refreshed."
      )
    }
  }
}
