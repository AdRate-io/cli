import { randomUUID } from "node:crypto"
import {
  CLIENT_ID,
  DEADLINES_MS,
  DEVICE_GRANT_TYPE,
  EXIT_CODE,
  M0_CAPABILITIES,
  M0_SCOPE,
} from "../constants.js"
import { createLocalSuccess } from "../contracts/envelope.js"
import {
  decodeDeviceCodeResponse,
  decodeOAuthError,
} from "../contracts/oauth.js"
import {
  authenticationFailure,
  dependencyFailure,
  localRequestId,
  outcomeUnknownFailure,
  prependFailureWarning,
  usageFailure,
} from "../errors.js"
import { HttpTransportError, parseRetryAfter } from "../http/client.js"
import { outcomeFromEnvelope } from "../output.js"
import { credentialStorageWarning } from "../storage/credential-backend.js"
import { addSeconds, oauthWaitOutcome } from "./auth-command-support.js"
import { classifyOAuthPollResponse } from "./oauth-response-classifier.js"
import type { ValidatedAuthLoginInput } from "./auth-command-support.js"
import type { AuthContext } from "./auth-context.js"
import type {
  DevicePollCoordinator,
  FrozenDevicePoll,
} from "./device-poll-coordinator.js"
import type { SessionIdentityService } from "./session-identity-service.js"
import type { LogoutRecoveryService } from "./logout-recovery-service.js"
import type { CliEnvironment } from "../constants.js"
import type { JsonObject } from "../contracts/json.js"
import type { CliOutcome } from "../errors.js"
import type { GlobalOptions } from "../parser.js"
import type {
  DeviceAuthorizationState,
  DeviceIssueReservation,
} from "../storage/schemas.js"

/** 只负责 Device 发码、poll 调度和 Token 持久化。 */
export class DeviceAuthorizationService {
  constructor(
    private readonly context: AuthContext,
    private readonly devicePoll: DevicePollCoordinator,
    private readonly identity: SessionIdentityService,
    private readonly logoutRecovery: LogoutRecoveryService
  ) {}

  async login(
    input: ValidatedAuthLoginInput,
    emitDeviceCodeLine?: (line: string) => void
  ): Promise<CliOutcome> {
    if (input.device && !emitDeviceCodeLine) {
      throw dependencyFailure(
        "The Device Authorization output stream is unavailable."
      )
    }
    if (!input.global.test) await this.devicePoll.normalizeForLogin()
    if (!input.global.test) {
      const normalization = await this.normalizeCredentialState(input.global)
      if (normalization !== null) return normalization
    }
    if (input.noWait) {
      return this.issueDeviceAuthorization({
        global: input.global,
        deviceName: input.deviceName,
      })
    }
    if (input.resume) {
      return (await this.resumeDeviceAuthorization(input.global)).outcome
    }

    let state = await this.context.local.state.readDeviceState()
    if (input.global.test || input.deviceNameProvided || !state) {
      const issued = await this.issueDeviceAuthorization({
        global: input.global,
        deviceName: input.deviceName,
      })
      if (!issued.envelope.ok) return issued
      if (input.device) {
        this.emitDeviceCodeLine(issued.envelope.data, emitDeviceCodeLine)
      } else {
        this.context.progress(
          `Open ${String(issued.envelope.data.verificationUriComplete)} and approve code ${String(issued.envelope.data.userCode)}.`
        )
      }
      state = await this.context.local.state.readDeviceState()
    } else if (input.device) {
      const expiresMs = new Date(state.expiresAt).getTime()
      if (expiresMs <= this.context.now().getTime()) {
        await this.context.local.state.clearDeviceState()
        const issued = await this.issueDeviceAuthorization({
          global: input.global,
          deviceName: input.deviceName,
        })
        if (!issued.envelope.ok) return issued
        this.emitDeviceCodeLine(issued.envelope.data, emitDeviceCodeLine)
        state = await this.context.local.state.readDeviceState()
      } else {
        this.emitDeviceCodeLine(
          {
            verificationUriComplete: state.verificationUriComplete,
            verificationUri: state.verificationUri,
            userCode: state.userCode,
            expiresAt: state.expiresAt,
          },
          emitDeviceCodeLine
        )
      }
    }
    while (state) {
      const wait = Math.max(
        0,
        new Date(state.nextPollAt).getTime() - this.context.now().getTime()
      )
      if (wait > 0) await this.context.sleep(wait)
      const resumed = await this.resumeDeviceAuthorization(input.global)
      const outcome = resumed.outcome
      if (
        !outcome.envelope.ok &&
        (outcome.envelope.error.details.oauthError ===
          "authorization_pending" ||
          outcome.envelope.error.details.oauthError === "slow_down")
      ) {
        state = await this.context.local.state.readDeviceState()
        continue
      }
      return outcome
    }
    throw authenticationFailure("The Device Authorization state expired.")
  }

  /**
   * Accio device-code 输出：一行顶层 JSON，包含框架 stdout 解析所需的四个键。
   * 只在 --device 模式下调用，不影响 envelope 或现有命令的 stdout 形态。
   */
  private emitDeviceCodeLine(
    data: Record<string, unknown>,
    emit: ((line: string) => void) | undefined
  ): void {
    if (!emit) {
      throw dependencyFailure(
        "The Device Authorization output stream is unavailable."
      )
    }
    const line = JSON.stringify({
      verificationUriComplete: data.verificationUriComplete,
      verificationUri: data.verificationUri,
      userCode: data.userCode,
      expiresIn: this.computeExpiresInSeconds(data.expiresAt),
    })
    emit(line)
  }

  private computeExpiresInSeconds(expiresAt: unknown): number {
    if (typeof expiresAt !== "string") return 600
    const remainingMs =
      new Date(expiresAt).getTime() - this.context.now().getTime()
    return Math.max(1, Math.ceil(remainingMs / 1000))
  }

  /**
   * 登录前凭据归一化：检测并处理残留状态，使 login 可以正常发码。
   *
   * 两种残留特征：
   * 1. credentials.json 缺失但已激活 Token 存在（Accio 断连）
   * 2. credentials.json 记录的 absoluteExpiresAt 已到期
   *
   * 归一化会尝试远端 logout，**只有拿到精确 revoked 成功体或
   * INVALID_CREDENTIAL / CREDENTIAL_EXPIRED / USER_DISABLED 才清理本地凭据**；
   * transport 失败、401/403、未知业务码一律保留凭据、返回 unknown
   * 并退出 5。正常有效凭据不属于归一化对象，仍由发码守卫拒绝重复登录。
   */
  private async normalizeCredentialState(
    global: GlobalOptions
  ): Promise<CliOutcome | null> {
    const inspection = await this.context.local.inspectAndRecover()

    if (inspection.state === "none" || inspection.state === "device_only") {
      return null
    }

    if (inspection.state === "local_incomplete") {
      if (inspection.reason === "token_missing") {
        return this.logoutRecovery.logoutInspected(global, inspection)
      }
      return null
    }

    // Token 刚落 Keychain 但 /me 未激活时也没有 credentials.json。
    // device=token_received 是该可恢复路径的唯一区分信号，不能当作 Accio 断连。
    const disconnected =
      inspection.credentials === null &&
      inspection.device?.localState !== "token_received"
    const absoluteExpiresAt = inspection.credentials?.absoluteExpiresAt
    const expired =
      absoluteExpiresAt !== undefined &&
      Date.parse(absoluteExpiresAt) <= this.context.now().getTime()

    if (!disconnected && !expired) return null

    const logout = await this.logoutRecovery.logoutInspected(global, inspection)
    if (logout.exitCode !== EXIT_CODE.success) {
      return logout
    }
    return null
  }

  private async issueDeviceAuthorization(input: {
    global: GlobalOptions
    deviceName: string | null
  }): Promise<CliOutcome> {
    const environment: CliEnvironment = input.global.test
      ? "test"
      : "production"
    const generation = randomUUID()
    const deviceName = input.deviceName
    const reservation = await this.context.local.state.withAuthLock(
      async () => {
        let snapshot = await this.context.local.readLocalSnapshotLocked()
        if (input.global.test && snapshot.issueReservation) {
          throw usageFailure(
            "--test requires no existing Device Authorization or credential state."
          )
        }
        if (snapshot.issueReservation) {
          if (snapshot.device) {
            await this.context.local.state.clearDeviceIssueReservation()
            snapshot = await this.context.local.readLocalSnapshotLocked()
          } else {
            throw usageFailure(
              "Another Device Authorization request is already in progress."
            )
          }
        }
        if (
          snapshot.index ||
          snapshot.metadata ||
          snapshot.fallbackExists ||
          snapshot.pollAttempt ||
          snapshot.device?.localState === "token_received"
        ) {
          throw usageFailure(
            "A credential already exists. Run auth whoami or auth logout first."
          )
        }
        if (snapshot.device) {
          if (input.global.test) {
            throw usageFailure(
              "--test requires no existing Device Authorization or credential state."
            )
          }
          const nowMs = this.context.now().getTime()
          if (nowMs < new Date(snapshot.device.expiresAt).getTime()) {
            throw usageFailure(
              "An active Device Authorization already exists. Use auth login --resume."
            )
          }
          await this.context.local.state.clearDeviceState()
        }
        const config = await this.context.local.state.ensureConfig(environment)
        const value: DeviceIssueReservation = {
          formatVersion: 1,
          generation,
          environment,
          issuerOrigin: config.issuerOrigin,
          clientInstanceId: config.clientInstanceId,
          deviceName,
        }
        await this.context.local.state.writeDeviceIssueReservation(value)
        return value
      }
    )

    let finalized = false
    try {
      await this.context.local.preflightCredentialStorage()
      const form = new URLSearchParams({
        client_id: CLIENT_ID,
        scope: M0_SCOPE,
        client_instance_id: reservation.clientInstanceId,
      })
      if (deviceName !== null) form.set("device_name", deviceName)
      let response
      try {
        response = await this.context.http.requestRaw({
          method: "POST",
          issuerOrigin: reservation.issuerOrigin,
          path: "/oauth/device/code",
          deadlineMs: DEADLINES_MS.standard,
          requestId: input.global.requestId,
          form,
        })
      } catch {
        throw dependencyFailure("Device Authorization could not be started.")
      }
      const receivedAt = this.context.now().toISOString()
      if (response.status < 200 || response.status >= 300) {
        const oauthError = decodeOAuthError(response.text)
        if (oauthError?.error === "temporarily_unavailable") {
          throw dependencyFailure(
            "Device Authorization is temporarily unavailable.",
            EXIT_CODE.retryable,
            {
              retryAfterSeconds: parseRetryAfter(response.headers) ?? undefined,
            } as JsonObject
          )
        }
        throw usageFailure(
          "The authorization server rejected the Device request."
        )
      }
      const decoded = decodeDeviceCodeResponse(
        response.text,
        reservation.issuerOrigin
      )
      if (!decoded) {
        throw dependencyFailure(
          "The authorization server returned an invalid Device response."
        )
      }
      const expiresAt = addSeconds(receivedAt, decoded.expiresIn)
      const state: DeviceAuthorizationState = {
        formatVersion: 1,
        generation: reservation.generation,
        localState: "issued",
        clientId: CLIENT_ID,
        clientInstanceId: reservation.clientInstanceId,
        deviceName,
        requestedScopes: [...M0_CAPABILITIES],
        environment: reservation.environment,
        issuerOrigin: reservation.issuerOrigin,
        deviceCode: decoded.deviceCode,
        userCode: decoded.userCode,
        verificationUri: decoded.verificationUri,
        verificationUriComplete: decoded.verificationUriComplete,
        expiresAt,
        intervalSeconds: decoded.interval,
        createdAt: receivedAt,
        nextPollAt: addSeconds(receivedAt, decoded.interval),
      }
      await this.context.local.state.withAuthLock(async () => {
        const current =
          await this.context.local.state.readDeviceIssueReservation()
        if (
          !current ||
          current.generation !== reservation.generation ||
          current.issuerOrigin !== reservation.issuerOrigin ||
          current.clientInstanceId !== reservation.clientInstanceId
        ) {
          throw dependencyFailure(
            "Device Authorization state ownership changed before it could be stored."
          )
        }
        const snapshot = await this.context.local.readLocalSnapshotLocked()
        if (
          snapshot.index ||
          snapshot.metadata ||
          snapshot.fallbackExists ||
          snapshot.device ||
          snapshot.pollAttempt
        ) {
          throw usageFailure(
            "Local authentication state changed while Device Authorization was being issued."
          )
        }
        await this.context.local.state.writeDeviceState(state)
        await this.context.local.state.clearDeviceIssueReservation()
      })
      finalized = true
      const envelope = createLocalSuccess(response.requestId, {
        verificationUri: decoded.verificationUri,
        verificationUriComplete: decoded.verificationUriComplete,
        userCode: decoded.userCode,
        expiresAt,
        interval: decoded.interval,
      })
      return {
        exitCode: EXIT_CODE.success,
        envelope,
        warnings: [],
        humanLines: [
          `Verification URL: ${decoded.verificationUriComplete}`,
          `User code: ${decoded.userCode}`,
          `Expires at: ${expiresAt}`,
        ],
      }
    } finally {
      if (!finalized) await this.releaseIssueReservation(generation)
    }
  }

  private async resumeDeviceAuthorization(
    global: GlobalOptions
  ): Promise<{ outcome: CliOutcome }> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const preparation = await this.devicePoll.prepare()
      if (preparation.kind === "reinspect") {
        const recovered = await this.context.local.inspectAndRecover()
        if (recovered.state === "device_only" || recovered.state === "none") {
          continue
        }
        if (recovered.state !== "located") {
          throw usageFailure(
            "Local credential state changed while resuming authorization."
          )
        }
        const warning = credentialStorageWarning(recovered.index.storageKind)
        let me
        try {
          me = await this.identity.callMe(recovered, global, true)
        } catch (error) {
          throw prependFailureWarning(error, warning)
        }
        const outcome =
          "error" in me
            ? outcomeFromEnvelope(me.error, this.context.environment)
            : outcomeFromEnvelope(me.envelope, this.context.environment)
        return {
          outcome:
            warning === null
              ? outcome
              : { ...outcome, warnings: [warning, ...outcome.warnings] },
        }
      }
      if (preparation.kind === "wait") {
        return {
          outcome: oauthWaitOutcome(
            localRequestId(),
            "authorization_pending",
            preparation.retryAfterSeconds
          ),
        }
      }
      const frozen = await this.devicePoll.freezeBackend(preparation)
      return {
        outcome: await this.pollToken(frozen, global),
      }
    }
    throw dependencyFailure(
      "Local authentication state changed repeatedly while authorization was resuming."
    )
  }

  private async pollToken(
    poll: FrozenDevicePoll,
    global: GlobalOptions
  ): Promise<CliOutcome> {
    const device = poll.device
    const form = new URLSearchParams({
      grant_type: DEVICE_GRANT_TYPE,
      device_code: device.deviceCode!,
      client_id: CLIENT_ID,
    })
    let response
    try {
      response = await this.context.http.requestRaw({
        method: "POST",
        issuerOrigin: device.issuerOrigin,
        path: "/oauth/token",
        deadlineMs: DEADLINES_MS.standard,
        requestId: global.requestId,
        form,
      })
    } catch (error) {
      await this.devicePoll.abandonUnknown(poll)
      throw outcomeUnknownFailure(
        "The Device Token exchange outcome is unknown. Run auth login again to start a new Device Authorization.",
        {
          failureKind:
            error instanceof HttpTransportError ? error.kind : "network",
        }
      )
    }
    const receivedAt = this.context.now().toISOString()
    const classification = classifyOAuthPollResponse({
      response,
      receivedAt,
      protocolIntervalSeconds: device.intervalSeconds,
    })
    if (classification.kind === "token") {
      const persisted = await this.context.local.persistToken({
        response: classification.token,
        device,
        attempt: poll.attempt,
        tokenReceivedAt: receivedAt,
      })
      let me
      try {
        me = await this.identity.callMe(persisted.located, global, true)
      } catch (error) {
        throw prependFailureWarning(error, persisted.warning)
      }
      const outcome =
        "error" in me
          ? outcomeFromEnvelope(me.error, this.context.environment)
          : outcomeFromEnvelope(me.envelope, this.context.environment)
      return {
        ...outcome,
        warnings: [
          ...(persisted.warning ? [persisted.warning] : []),
          ...outcome.warnings,
        ],
      }
    }
    if (classification.kind === "delivery_unknown") {
      await this.devicePoll.abandonUnknown(poll)
      throw outcomeUnknownFailure(
        classification.responseKind === "invalid_success"
          ? "The Device Token response was invalid. Run auth login again to start a new Device Authorization."
          : "The Device Token server returned a non-JSON failure. Run auth login again to start a new Device Authorization."
      )
    }
    if (classification.kind === "terminal") {
      this.assertPollCompletion(await this.devicePoll.completeTerminal(poll))
      throw authenticationFailure(
        classification.oauthError === "access_denied"
          ? "The Owner denied this Device Authorization."
          : "The Device Authorization expired or was already consumed."
      )
    }
    if (classification.kind === "pending") {
      this.assertPollCompletion(
        await this.devicePoll.completePollResponse(poll, (current) =>
          this.devicePoll.applyOAuthSchedule(
            current,
            receivedAt,
            "authorization_pending",
            classification.protocolIntervalSeconds
          )
        )
      )
      return oauthWaitOutcome(
        response.requestId,
        classification.oauthError,
        classification.protocolIntervalSeconds
      )
    }
    if (classification.kind === "slow_down") {
      this.assertPollCompletion(
        await this.devicePoll.completePollResponse(poll, (current) =>
          this.devicePoll.applyOAuthSchedule(
            current,
            receivedAt,
            "slow_down",
            classification.protocolIntervalSeconds,
            classification.protocolIntervalSeconds,
            classification.retryAfterSeconds
          )
        )
      )
      return oauthWaitOutcome(
        response.requestId,
        "slow_down",
        classification.protocolIntervalSeconds
      )
    }
    if (classification.kind === "temporarily_unavailable") {
      this.assertPollCompletion(
        await this.devicePoll.completePollResponse(poll, (current) =>
          this.devicePoll.applyOAuthSchedule(
            current,
            receivedAt,
            "temporarily_unavailable",
            classification.protocolIntervalSeconds,
            classification.nextPollDelaySeconds,
            classification.retryAfterSeconds
          )
        )
      )
      throw dependencyFailure(
        "The authorization service is temporarily unavailable.",
        EXIT_CODE.retryable,
        {
          retryAfterSeconds: classification.nextPollDelaySeconds,
          oauthError: "temporarily_unavailable",
          suggestedAction: "retry_after",
        }
      )
    }
    if (classification.kind === "invalid_slow_down") {
      this.assertPollCompletion(
        await this.devicePoll.completePollResponse(poll, (current) =>
          this.devicePoll.applyOAuthSchedule(
            current,
            receivedAt,
            "oauth_error",
            classification.protocolIntervalSeconds
          )
        )
      )
      throw dependencyFailure(
        "The OAuth slow_down response has an invalid Retry-After value.",
        EXIT_CODE.business
      )
    }
    this.assertPollCompletion(
      await this.devicePoll.completePollResponse(poll, (current) =>
        this.devicePoll.applyOAuthSchedule(
          current,
          receivedAt,
          "oauth_error",
          device.intervalSeconds
        )
      )
    )
    throw dependencyFailure(
      classification.oauthError === null
        ? "The authorization server returned an invalid OAuth error."
        : "The authorization server rejected the Token request.",
      EXIT_CODE.business,
      classification.oauthError === null
        ? {}
        : { oauthError: classification.oauthError }
    )
  }

  private assertPollCompletion(completed: boolean): void {
    if (!completed) {
      throw dependencyFailure(
        "Device poll state changed while the response was being finalized; no current state was modified."
      )
    }
  }

  private async releaseIssueReservation(generation: string): Promise<void> {
    await this.context.local.state.withAuthLock(async () => {
      const current =
        await this.context.local.state.readDeviceIssueReservation()
      if (current?.generation === generation) {
        await this.context.local.state.clearDeviceIssueReservation()
      }
    })
  }
}
