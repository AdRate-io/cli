import { Agent, Headers, fetch } from "undici"
import {
  DEADLINES_MS,
  IDEMPOTENCY_KEY_PATTERN,
  REQUEST_ID_PATTERN,
} from "../constants.js"
import { dependencyFailure, localRequestId } from "../errors.js"
import { decodePublicEnvelope } from "../contracts/envelope.js"
import {
  decodeDeviceCodeResponse,
  decodeDeviceTokenResponse,
  decodeOAuthError,
} from "../contracts/oauth.js"
import {
  environmentForMachineOrigin,
  validateBrowserUrl,
} from "../config/issuer.js"
import type { PublicEnvelope } from "../contracts/envelope.js"
import type { JsonObject } from "../contracts/json.js"
import type { Response as UndiciResponse } from "undici"

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const JSON_CONTENT_TYPE_PATTERN = /^application\/json(?:\s*;[^;]*)*$/i

export interface HttpRequest {
  method: "GET" | "POST" | "DELETE"
  issuerOrigin: string
  path: string
  deadlineMs: number
  requestId?: string
  token?: string
  form?: URLSearchParams
  json?: JsonObject
  idempotencyKey?: string
}

export interface HttpResponse {
  status: number
  headers: Readonly<Record<string, string>>
  text: string
  requestId: string
}

export interface HttpTransport {
  request: (input: HttpRequest) => Promise<HttpResponse>
}

export type HttpFailureKind = "timeout" | "network" | "invalid_response"

export class HttpTransportError extends Error {
  constructor(
    readonly kind: HttpFailureKind,
    message: string
  ) {
    super(message)
    this.name = "HttpTransportError"
  }
}

function validateRequestUrl(issuerOrigin: string, path: string): URL {
  let issuer: URL
  let url: URL
  try {
    issuer = new URL(issuerOrigin)
    url = new URL(path, issuer)
  } catch {
    throw new HttpTransportError("invalid_response", "Invalid request URL.")
  }
  if (
    issuer.protocol !== "https:" ||
    issuer.username.length > 0 ||
    issuer.password.length > 0 ||
    issuer.pathname !== "/" ||
    issuer.search.length > 0 ||
    issuer.hash.length > 0 ||
    environmentForMachineOrigin(issuer.origin) === null ||
    url.origin !== issuer.origin ||
    !path.startsWith("/")
  ) {
    throw new HttpTransportError("invalid_response", "Unsafe request URL.")
  }
  return url
}

async function readBoundedText(response: UndiciResponse): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let total = 0
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      total += result.value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new HttpTransportError(
          "invalid_response",
          "The response body is too large."
        )
      }
      chunks.push(result.value)
    }
  } catch (error) {
    if (error instanceof HttpTransportError) throw error
    throw new HttpTransportError(
      "network",
      "The response body could not be read."
    )
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(merged)
  } catch {
    throw new HttpTransportError(
      "invalid_response",
      "The response is not valid UTF-8."
    )
  }
}

function safeHeaders(headers: Headers): Readonly<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const name of ["content-type", "retry-after", "x-request-id"] as const) {
    const value = headers.get(name)
    if (value !== null) result[name] = value
  }
  return Object.freeze(result)
}

export class DefaultHttpTransport implements HttpTransport {
  async request(input: HttpRequest): Promise<HttpResponse> {
    const url = validateRequestUrl(input.issuerOrigin, input.path)
    const requestId = input.requestId ?? localRequestId()
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      throw new HttpTransportError(
        "invalid_response",
        "The request ID is invalid."
      )
    }
    if (
      (input.form !== undefined && input.json !== undefined) ||
      ((input.form !== undefined || input.json !== undefined) &&
        input.method !== "POST") ||
      (input.idempotencyKey !== undefined &&
        (input.method !== "POST" ||
          input.json === undefined ||
          !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)))
    ) {
      throw new HttpTransportError(
        "invalid_response",
        "The request body or idempotency key is invalid."
      )
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), input.deadlineMs)
    timeout.unref()
    const dispatcher = new Agent({
      connect: {
        timeout: Math.min(DEADLINES_MS.connect, input.deadlineMs),
      },
    })
    try {
      const headers = new Headers({
        Accept: "application/json",
        "X-AdRate-Origin": "cli",
        "X-Request-Id": requestId,
      })
      if (input.token !== undefined) {
        headers.set("Authorization", `Bearer ${input.token}`)
      }
      if (input.idempotencyKey !== undefined) {
        headers.set("Idempotency-Key", input.idempotencyKey)
      }
      let body: string | undefined
      if (input.form) {
        headers.set("Content-Type", "application/x-www-form-urlencoded")
        body = input.form.toString()
      } else if (input.json) {
        headers.set("Content-Type", "application/json")
        body = JSON.stringify(input.json)
      }
      const response = await fetch(url, {
        method: input.method,
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
        dispatcher,
      })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        throw new HttpTransportError(
          "invalid_response",
          "Redirects are not accepted."
        )
      }
      const text = await readBoundedText(response)
      const responseHeaders = safeHeaders(response.headers)
      const finalRequestId = responseHeaders["x-request-id"]
      if (!finalRequestId || !REQUEST_ID_PATTERN.test(finalRequestId)) {
        throw new HttpTransportError(
          "invalid_response",
          "The response request ID is missing or invalid."
        )
      }
      return {
        status: response.status,
        headers: responseHeaders,
        text,
        requestId: finalRequestId,
      }
    } catch (error) {
      if (error instanceof HttpTransportError) throw error
      if (
        controller.signal.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw new HttpTransportError("timeout", "The request timed out.")
      }
      throw new HttpTransportError("network", "The network request failed.")
    } finally {
      clearTimeout(timeout)
      await dispatcher.close().catch(() => undefined)
    }
  }
}

export interface PublicReadRequestInput {
  method: "GET" | "DELETE"
  issuerOrigin: string
  path: string
  token: string
  requestId?: string
  deadlineMs: number
  json?: never
  idempotencyKey?: never
}

interface PublicJsonPostBase {
  method: "POST"
  issuerOrigin: string
  path: string
  token: string
  idempotencyKey: string
  json: JsonObject
  requestId?: string
}

export interface PublicStatusJsonPostInput extends PublicJsonPostBase {
  deadlineMs: 120_000
}

export interface PublicStandardJsonPostInput extends PublicJsonPostBase {
  deadlineMs: 15_000
}

export type PublicJsonPostInput =
  | PublicStatusJsonPostInput
  | PublicStandardJsonPostInput

export type PublicRequestInput = PublicReadRequestInput | PublicJsonPostInput

export interface PublicResponse {
  response: HttpResponse
  envelope: PublicEnvelope
  retryAfterSeconds: number | null
}

function assertPublicRequestContract(input: PublicRequestInput): void {
  // TypeScript 调用方受联合类型约束；运行时校验仍需覆盖 JavaScript 和未检查的外部调用。
  /* eslint-disable @typescript-eslint/no-unnecessary-condition */
  if (
    input.method === "POST" &&
    (input.json === undefined ||
      input.idempotencyKey === undefined ||
      !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) ||
      (input.deadlineMs !== DEADLINES_MS.statusWrite &&
        input.deadlineMs !== DEADLINES_MS.standard))
  ) {
    throw new HttpTransportError(
      "invalid_response",
      "The Public API write request is invalid."
    )
  }
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */
}

export class PublicHttpClient {
  constructor(readonly transport: HttpTransport = new DefaultHttpTransport()) {}

  async requestRaw(input: HttpRequest): Promise<HttpResponse> {
    const response = await this.transport.request(input)
    if (input.path === "/oauth/device/code" || input.path === "/oauth/token") {
      assertOAuthResponseContract(input, response)
    }
    return response
  }

  async requestPublic(input: PublicRequestInput): Promise<PublicResponse> {
    return this.requestAndDecodePublic(input)
  }

  /**
   * Status 写命令的唯一公共 POST 入口。deadline 与 T08/T11 端到端
   * 预算绑定为 120 秒，调用方不能用更短超时改变写结果语义。
   */
  async postPublicJson(
    input: Omit<PublicStatusJsonPostInput, "method" | "deadlineMs">
  ): Promise<PublicResponse> {
    return this.requestAndDecodePublic({
      method: "POST",
      issuerOrigin: input.issuerOrigin,
      path: input.path,
      token: input.token,
      idempotencyKey: input.idempotencyKey,
      json: input.json,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      deadlineMs: DEADLINES_MS.statusWrite,
    })
  }

  private async requestAndDecodePublic(
    input: PublicRequestInput
  ): Promise<PublicResponse> {
    assertPublicRequestContract(input)
    const response = await this.transport.request(input)
    if (!isStrictJsonContentType(response.headers["content-type"])) {
      throw dependencyFailure(
        "The server returned an invalid Public API response.",
        undefined,
        { responseKind: "invalid_content_type" }
      )
    }
    const decoded = decodePublicEnvelope(response.text)
    if (!decoded.ok) {
      throw dependencyFailure(
        "The server returned an invalid Public API response.",
        undefined,
        { responseKind: decoded.reason }
      )
    }
    const statusIsSuccess = response.status >= 200 && response.status < 300
    const statusIsError = response.status >= 400 && response.status < 600
    if (
      (!statusIsSuccess && !statusIsError) ||
      statusIsSuccess !== decoded.envelope.ok
    ) {
      throw dependencyFailure(
        "The server returned an invalid Public API response.",
        undefined,
        { responseKind: "status_envelope_mismatch" }
      )
    }
    if (decoded.envelope.meta.requestId !== response.requestId) {
      throw dependencyFailure(
        "The server response request ID does not match its header.",
        undefined,
        { responseKind: "request_id_mismatch" }
      )
    }
    const retryAfterSeconds = parseRetryAfter(response.headers)
    const envelope =
      retryAfterSeconds === null
        ? decoded.envelope
        : ({
            ...decoded.envelope,
            meta: {
              ...decoded.envelope.meta,
              retryAfterSeconds,
            },
          } as PublicEnvelope)
    assertSafeResolutionUrls(envelope, input.issuerOrigin)
    return { response, envelope, retryAfterSeconds }
  }
}

function isStrictJsonContentType(value: string | undefined): boolean {
  return value !== undefined && JSON_CONTENT_TYPE_PATTERN.test(value)
}

function assertOAuthResponseContract(
  input: HttpRequest,
  response: HttpResponse
): void {
  if (!isStrictJsonContentType(response.headers["content-type"])) {
    throw new HttpTransportError(
      "invalid_response",
      "The OAuth response Content-Type is invalid."
    )
  }
  const statusIsSuccess = response.status >= 200 && response.status < 300
  const statusIsError = response.status >= 400 && response.status < 600
  if (!statusIsSuccess && !statusIsError) {
    throw new HttpTransportError(
      "invalid_response",
      "The OAuth response status is invalid."
    )
  }
  const validBody = statusIsSuccess
    ? input.path === "/oauth/device/code"
      ? decodeDeviceCodeResponse(response.text, input.issuerOrigin) !== null
      : decodeDeviceTokenResponse(response.text) !== null
    : decodeOAuthError(response.text) !== null
  if (!validBody) {
    throw new HttpTransportError(
      "invalid_response",
      "The OAuth response body does not match its HTTP status."
    )
  }
}

function assertSafeResolutionUrls(
  envelope: PublicEnvelope,
  issuerOrigin: string
): void {
  const values: Array<unknown> = []
  if (!envelope.ok) values.push(envelope.error.details.resolutionUrl)
  const credential = envelope.meta._notice?.credential
  if (
    credential &&
    typeof credential === "object" &&
    !Array.isArray(credential)
  ) {
    values.push(credential.resolutionUrl)
  }
  for (const value of values) {
    if (value === null || value === undefined) continue
    try {
      validateBrowserUrl(value, issuerOrigin)
    } catch {
      throw dependencyFailure(
        "The server returned an unsafe resolution URL.",
        undefined,
        { responseKind: "unsafe_resolution_url" }
      )
    }
  }
}

export function parseRetryAfter(
  headers: Readonly<Record<string, string>>,
  maximum = 86_400
): number | null {
  const value = headers["retry-after"]
  if (
    value === undefined ||
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > maximum
  ) {
    return null
  }
  return Number(value)
}
