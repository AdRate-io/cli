import { describe, expect, it, vi } from "vitest"
import { ReadCommandService } from "../src/commands/read-service.js"
import { CLI_VERSION } from "../src/constants.js"
import { HttpTransportError, PublicHttpClient } from "../src/http/client.js"
import { CliFailure } from "../src/errors.js"
import { parseArguments } from "../src/parser.js"
import type {
  LocalCredentialCoordinator,
  LocatedCredential,
} from "../src/auth/local-credentials.js"
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from "../src/http/client.js"
import type { ReadCommand } from "../src/parser.js"

const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111"
const TOKEN_GENERATION = "22222222-2222-4222-8222-222222222222"
const DEVICE_GENERATION = "33333333-3333-4333-8333-333333333333"
const POLL_OWNER_TOKEN = "44444444-4444-4444-8444-444444444444"
const LOCATED: LocatedCredential = {
  index: {
    tokenIndexFormatVersion: 1,
    generation: TOKEN_GENERATION,
    state: "stored",
    environment: "production",
    issuerOrigin: "https://api.adrate.io",
    credentialKind: "owner_cli_session",
    credentialId: CREDENTIAL_ID,
    clientInstanceId: "cli-instance-1",
    deviceGeneration: DEVICE_GENERATION,
    pollAttemptOwnerToken: POLL_OWNER_TOKEN,
    deviceName: "Boss-Mac",
    tokenReceivedAt: "2026-07-31T08:00:00.000Z",
    storageKind: "keychain",
    storageCommit: null,
  },
  token: `adr_owner_${CREDENTIAL_ID}_${"A".repeat(43)}`,
  credentials: {
    credentialFormatVersion: 1,
    credentialKind: "owner_cli_session",
    credentialId: CREDENTIAL_ID,
    issuerOrigin: "https://api.adrate.io",
    teamId: 7,
    teamName: "AdRate",
    deviceName: "Boss-Mac",
    clientInstanceId: "cli-instance-1",
    loggedInAt: "2026-07-31T08:00:00.000Z",
    cliVersion: CLI_VERSION,
  },
  device: null,
  identity: {
    environment: "production",
    issuerOrigin: "https://api.adrate.io",
    clientInstanceId: "cli-instance-1",
    tokenGeneration: TOKEN_GENERATION,
    deviceGeneration: DEVICE_GENERATION,
    issueOwnerToken: null,
    pollOwnerToken: POLL_OWNER_TOKEN,
  },
}

class RecordingTransport implements HttpTransport {
  readonly requests: Array<HttpRequest> = []

  constructor(
    private readonly failure: Error | null = null,
    private readonly extraMeta: Record<string, unknown> = {},
    private readonly responseOverride: {
      status: number
      headers?: Record<string, string>
      body: Record<string, unknown>
    } | null = null
  ) {}

  request(input: HttpRequest): Promise<HttpResponse> {
    this.requests.push(input)
    if (this.failure) return Promise.reject(this.failure)
    const requestId =
      input.requestId ?? `server-request-${this.requests.length}`
    return Promise.resolve({
      status: this.responseOverride?.status ?? 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-request-id": requestId,
        ...this.responseOverride?.headers,
      },
      requestId,
      text: JSON.stringify(
        this.responseOverride?.body ?? {
          ok: true,
          data: { requestedPath: input.path },
          meta: {
            ...this.extraMeta,
            requestId,
            apiVersion: "v1",
          },
        }
      ),
    })
  }
}

function createHarness(
  input: {
    located?: LocatedCredential
    transport?: RecordingTransport
  } = {}
): {
  service: ReadCommandService
  transport: RecordingTransport
  requireLocated: ReturnType<typeof vi.fn>
} {
  const located = input.located ?? LOCATED
  const transport = input.transport ?? new RecordingTransport()
  const requireLocated = vi.fn(() => Promise.resolve(located))
  const local = {
    requireLocated,
  } as unknown as LocalCredentialCoordinator
  return {
    service: new ReadCommandService(new PublicHttpClient(transport), local, {}),
    transport,
    requireLocated,
  }
}

async function executeArgv(
  service: ReadCommandService,
  argv: ReadonlyArray<string>
) {
  const invocation = parseArguments(argv)
  if (!invocation.command || invocation.command.kind.startsWith("auth.")) {
    throw new Error("Expected a read command")
  }
  return service.execute(invocation.command as ReadCommand, invocation.global)
}

async function expectUsageWithoutNetwork(
  argv: ReadonlyArray<string>
): Promise<void> {
  const harness = createHarness()
  await expect(executeArgv(harness.service, argv)).rejects.toMatchObject({
    exitCode: 2,
  })
  expect(harness.requireLocated).not.toHaveBeenCalled()
  expect(harness.transport.requests).toHaveLength(0)
}

describe("ReadCommandService HTTP mapping", () => {
  it.each([
    [["capabilities"], "/public/v1/capabilities", 15_000],
    [
      ["schema", "identity.read"],
      "/public/v1/capabilities/identity.read",
      15_000,
    ],
    [["schema", "future.read"], "/public/v1/capabilities/future.read", 15_000],
    [["ads", "advertisers"], "/public/v1/ads/advertisers", 15_000],
    [
      ["ads", "campaigns", "list", "--adv-id", "00070001"],
      "/public/v1/ads/advertisers/00070001/campaigns",
      45_000,
    ],
    [
      [
        "ads",
        "campaigns",
        "list",
        "--adv-id",
        "70001",
        "--auth-id",
        "42",
        "--page",
        "3",
        "--page-size",
        "1000",
      ],
      "/public/v1/ads/advertisers/70001/campaigns?authId=42&page=3&pageSize=1000",
      45_000,
    ],
    [
      [
        "ads",
        "campaigns",
        "get",
        "--adv-id",
        "70001",
        "--campaign-id",
        "campaign-A",
        "--auth-id",
        "42",
      ],
      "/public/v1/ads/advertisers/70001/campaigns/campaign-A?authId=42",
      45_000,
    ],
    [
      [
        "ads",
        "report",
        "campaigns",
        "--adv-id",
        "70001",
        "--start-date",
        "2026-07-01",
        "--end-date",
        "2026-07-31",
      ],
      "/public/v1/ads/advertisers/70001/reports/campaigns?startDate=2026-07-01&endDate=2026-07-31",
      45_000,
    ],
    [
      [
        "ads",
        "report",
        "campaigns",
        "--adv-id",
        "70001",
        "--start-date",
        "2026-07-01",
        "--end-date",
        "2026-07-31",
        "--group-by",
        "day",
        "--auth-id",
        "42",
        "--page",
        "2",
        "--page-size",
        "50",
      ],
      "/public/v1/ads/advertisers/70001/reports/campaigns?startDate=2026-07-01&endDate=2026-07-31&groupBy=day&authId=42&page=2&pageSize=50",
      45_000,
    ],
  ] as const)(
    "%j 只发一次冻结 path/query，deadline=%s",
    async (argv, expectedPath, expectedDeadline) => {
      const harness = createHarness()
      const outcome = await executeArgv(harness.service, argv)

      expect(outcome.exitCode).toBe(0)
      expect(harness.transport.requests).toHaveLength(1)
      expect(harness.transport.requests[0]).toEqual({
        method: "GET",
        issuerOrigin: "https://api.adrate.io",
        path: expectedPath,
        token: LOCATED.token,
        deadlineMs: expectedDeadline,
      })
    }
  )

  it("透传 request-id，但绝不把预留 idempotency-key 塞进只读请求", async () => {
    const harness = createHarness()
    await executeArgv(harness.service, [
      "ads",
      "campaigns",
      "list",
      "--adv-id",
      "70001",
      "--request-id",
      "Agent_trace_1",
      "--idempotency-key",
      "reserved_write_key",
    ])
    expect(harness.transport.requests[0]).toMatchObject({
      requestId: "Agent_trace_1",
      path: "/public/v1/ads/advertisers/70001/campaigns",
    })
    expect(JSON.stringify(harness.transport.requests[0])).not.toContain(
      "reserved_write_key"
    )
  })

  it("不因 pagination 元数据自动请求下一页", async () => {
    const transport = new RecordingTransport(null, {
      pagination: {
        page: 1,
        pageSize: 50,
        totalNumber: 500,
        totalPage: 10,
      },
    })
    const harness = createHarness({ transport })
    const outcome = await executeArgv(harness.service, [
      "ads",
      "campaigns",
      "list",
      "--adv-id",
      "70001",
    ])

    expect(outcome.exitCode).toBe(0)
    expect(transport.requests).toHaveLength(1)
    expect(outcome.envelope.meta.pagination).toEqual({
      page: 1,
      pageSize: 50,
      totalNumber: 500,
      totalPage: 10,
    })
  })

  it("Public Retry-After 贯穿 CliOutcome、JSON meta 与 human warning", async () => {
    const requestId = "read-retry-after"
    const transport = new RecordingTransport(
      null,
      {},
      {
        status: 429,
        headers: { "retry-after": "5" },
        body: {
          ok: false,
          error: {
            code: "UPSTREAM_RATE_LIMITED",
            message: "TikTok rate limited the request.",
            retryable: true,
            details: {
              suggestedAction: "retry_after",
              resolutionUrl: null,
            },
          },
          meta: {
            requestId,
            apiVersion: "v1",
          },
        },
      }
    )
    const harness = createHarness({ transport })
    const outcome = await executeArgv(harness.service, [
      "capabilities",
      "--request-id",
      requestId,
    ])

    expect(outcome.exitCode).toBe(4)
    expect(outcome.retryAfterSeconds).toBe(5)
    expect(outcome.envelope.meta.retryAfterSeconds).toBe(5)
    expect(outcome.warnings).toContain(
      "Retry after 5 second(s) before repeating this request."
    )
  })

  it("网络/timeout/invalid response 都映射为只读可有界重试的退出 4", async () => {
    for (const kind of ["network", "timeout", "invalid_response"] as const) {
      const transport = new RecordingTransport(
        new HttpTransportError(kind, "transport failed")
      )
      const harness = createHarness({ transport })
      await expect(
        executeArgv(harness.service, ["capabilities"])
      ).rejects.toMatchObject({
        exitCode: 4,
      })
      expect(transport.requests).toHaveLength(1)
    }
  })

  it("未完成 /me 激活时不发业务请求并退出认证错误", async () => {
    const harness = createHarness({
      located: {
        ...LOCATED,
        credentials: null,
      },
    })
    await expect(
      executeArgv(harness.service, ["capabilities"])
    ).rejects.toMatchObject({
      exitCode: 3,
    })
    expect(harness.transport.requests).toHaveLength(0)
  })

  it("--test 在任何只读命令上都在本地拒绝", async () => {
    const harness = createHarness()
    await expect(
      executeArgv(harness.service, ["capabilities", "--test"])
    ).rejects.toMatchObject({
      exitCode: 2,
    })
    expect(harness.requireLocated).not.toHaveBeenCalled()
    expect(harness.transport.requests).toHaveLength(0)
  })
})

describe("ReadCommandService preflight validation", () => {
  it.each([
    ["schema", "."],
    ["schema", ".."],
    ["schema", " future.read"],
    ["schema", "future.read "],
    ["schema", "future/read"],
    ["schema", "future%read"],
    ["schema", "future?read"],
    ["schema", "未来.read"],
    ["schema", `future${String.fromCharCode(0)}read`],
    ["schema", "a".repeat(129)],
  ])("schema 危险 path %j 在联网前拒绝", async (...argv) => {
    await expectUsageWithoutNetwork(argv)
  })

  it.each([
    ["ads", "campaigns", "list"],
    ["ads", "campaigns", "get", "--adv-id", "70001"],
    [
      "ads",
      "report",
      "campaigns",
      "--adv-id",
      "70001",
      "--start-date",
      "2026-07-01",
    ],
    ["ads", "campaigns", "list", "--adv-id", " 70001"],
    ["ads", "campaigns", "list", "--adv-id", "70001%2Fother"],
    ["ads", "campaigns", "list", "--adv-id", "投放账户"],
    ["ads", "campaigns", "get", "--adv-id", "70001", "--campaign-id", "."],
    ["ads", "campaigns", "get", "--adv-id", "70001", "--campaign-id", "a/b"],
    [
      "ads",
      "campaigns",
      "get",
      "--adv-id",
      "70001",
      "--campaign-id",
      "c".repeat(129),
    ],
    ["ads", "campaigns", "list", "--adv-id", "70001", "--auth-id", "0"],
    ["ads", "campaigns", "list", "--adv-id", "70001", "--page", "01"],
    ["ads", "campaigns", "list", "--adv-id", "70001", "--page-size", "1001"],
  ])("Campaign 非法输入 %j 在联网前拒绝", async (...argv) => {
    await expectUsageWithoutNetwork(argv)
  })

  it.each([
    [
      "ads",
      "report",
      "campaigns",
      "--adv-id",
      "70001",
      "--start-date",
      "2026-02-29",
      "--end-date",
      "2026-03-01",
    ],
    [
      "ads",
      "report",
      "campaigns",
      "--adv-id",
      "70001",
      "--start-date",
      "2026-07-02",
      "--end-date",
      "2026-07-01",
    ],
    [
      "ads",
      "report",
      "campaigns",
      "--adv-id",
      "70001",
      "--start-date",
      "2026-01-01",
      "--end-date",
      "2026-02-01",
      "--group-by",
      "day",
    ],
    [
      "ads",
      "report",
      "campaigns",
      "--adv-id",
      "70001",
      "--start-date",
      "2026-07-01",
      "--end-date",
      "2026-07-02",
      "--group-by",
      "hour",
    ],
    [
      "ads",
      "report",
      "campaigns",
      "--adv-id",
      "70001",
      "--start-date",
      "2026-07-01",
      "--end-date",
      "2026-07-01",
      "--group-by",
      "week",
    ],
  ])("报表非法日期/groupBy %j 在联网前拒绝", async (...argv) => {
    await expectUsageWithoutNetwork(argv)
  })

  it.each([
    ["none", "2025-01-01", "2026-01-01"],
    ["day", "2026-07-01", "2026-07-31"],
    ["hour", "2026-07-31", "2026-07-31"],
  ] as const)(
    "groupBy=%s 接受冻结跨度上界",
    async (groupBy, startDate, endDate) => {
      const harness = createHarness()
      await executeArgv(harness.service, [
        "ads",
        "report",
        "campaigns",
        "--adv-id",
        "70001",
        "--start-date",
        startDate,
        "--end-date",
        endDate,
        "--group-by",
        groupBy,
      ])
      expect(harness.transport.requests).toHaveLength(1)
    }
  )
})
