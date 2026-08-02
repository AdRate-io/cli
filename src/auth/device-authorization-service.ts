import { randomUUID } from "node:crypto"
import {
  CLIENT_ID,
  DEADLINES_MS,
  DEVICE_DELIVERY_SAFETY_WINDOW_MS,
  DEVICE_GRANT_TYPE,
  DEVICE_TRANSACTION_LEASE_MS,
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
  DevicePollAcknowledgedRecovery,
  DevicePollCoordinator,
  FrozenDevicePoll,
} from "./device-poll-coordinator.js"
import type { SessionIdentityService } from "./session-identity-service.js"
import type { CliEnvironment } from "../constants.js"
import type { JsonObject } from "../contracts/json.js"
import type { CliOutcome } from "../errors.js"
import type { GlobalOptions } from "../parser.js"
import type {
  DeviceAuthorizationState,
  DeviceIssueReservation,
  DevicePollAcknowledgedResponseKind,
} from "../storage/schemas.js"

function acknowledgedResponseKind(
  oauthError: string | null
): DevicePollAcknowledgedResponseKind {
  return oauthError === "authorization_pending" ||
    oauthError === "slow_down" ||
    oauthError === "temporarily_unavailable"
    ? oauthError
    : "oauth_error"
}

interface DeviceResumeResult {
  outcome: CliOutcome
  recoveredResponse: boolean
}

/** 只负责 Device 发码、poll 调度、一次性交付和 Token storage commit。 */
export class DeviceAuthorizationService {
  constructor(
    private readonly context: AuthContext,
    private readonly devicePoll: DevicePollCoordinator,
    private readonly identity: SessionIdentityService
  ) {}

  async login(
    input: ValidatedAuthLoginInput,
    recoveredAcknowledgement: DevicePollAcknowledgedRecovery | null = null
  ): Promise<CliOutcome> {
    const deviceName = input.deviceName
    if (recoveredAcknowledgement !== null) {
      return this.recoveredAcknowledgementOutcome(recoveredAcknowledgement)
    }
    if (input.noWait) {
      return this.issueDeviceAuthorization({
        global: input.global,
        deviceName,
      })
    }
    if (input.resume) {
      return (
        await this.resumeDeviceAuthorizationWithRecoverySignal(input.global)
      ).outcome
    }

    let state = await this.context.local.state.readDeviceState()
    if (input.global.test || input.deviceNameProvided || !state) {
      const issued = await this.issueDeviceAuthorization({
        global: input.global,
        deviceName,
      })
      if (!issued.envelope.ok) return issued
      this.context.progress(
        `Open ${String(issued.envelope.data.verificationUriComplete)} and approve code ${String(issued.envelope.data.userCode)}.`
      )
      state = await this.context.local.state.readDeviceState()
    }
    while (state) {
      const wait = Math.max(
        0,
        new Date(state.nextPollAt).getTime() - this.context.now().getTime()
      )
      if (wait > 0) await this.context.sleep(wait)
      const resumed = await this.resumeDeviceAuthorizationWithRecoverySignal(
        input.global
      )
      const outcome = resumed.outcome
      if (resumed.recoveredResponse) return outcome
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

  private async issueDeviceAuthorization(input: {
    global: GlobalOptions
    deviceName: string | null
  }): Promise<CliOutcome> {
    const environment: CliEnvironment = input.global.test
      ? "test"
      : "production"
    const ownerToken = randomUUID()
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
          const createdAt = new Date(
            snapshot.issueReservation.createdAt
          ).getTime()
          const age = this.context.now().getTime() - createdAt
          if (age < 0 || age < DEVICE_TRANSACTION_LEASE_MS) {
            throw usageFailure(
              "Another Device Authorization request is already in progress."
            )
          }
          await this.context.local.state.clearDeviceIssueReservation()
          snapshot = await this.context.local.readLocalSnapshotLocked()
        }
        if (!snapshot.index) {
          snapshot =
            await this.context.local.settleTerminalDeviceLocked(snapshot)
        }
        if (
          snapshot.index ||
          snapshot.metadata ||
          snapshot.fallbackExists ||
          snapshot.pollAttempt ||
          snapshot.cleanupReservation ||
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
          const device = snapshot.device
          const nowMs = this.context.now().getTime()
          const expiresAt = new Date(device.expiresAt).getTime()
          const attemptedAt = device.deliveryVerificationAttemptedAt
            ? new Date(device.deliveryVerificationAttemptedAt).getTime()
            : null
          const safeRestartAt =
            attemptedAt === null
              ? expiresAt
              : Math.max(
                  expiresAt,
                  attemptedAt + DEVICE_DELIVERY_SAFETY_WINDOW_MS
                )
          if (nowMs < safeRestartAt) {
            throw usageFailure(
              "An active Device Authorization already exists. Use auth login --resume."
            )
          }
          await this.context.local.state.clearDeviceState()
          if (device.localState === "delivery_unknown") {
            throw authenticationFailure(
              "The previous one-time Token delivery fence reached its safe restart boundary and was cleared. Start a new Device Authorization with a new auth login --no-wait invocation.",
              "CREDENTIAL_EXPIRED",
              {
                deliveryState: "safe_restart_cleared",
                safeRestartAt: new Date(safeRestartAt).toISOString(),
              }
            )
          }
        }
        const config = await this.context.local.state.ensureConfig(environment)
        const value: DeviceIssueReservation = {
          formatVersion: 1,
          ownerToken,
          environment,
          issuerOrigin: config.issuerOrigin,
          clientInstanceId: config.clientInstanceId,
          deviceName,
          createdAt: this.context.now().toISOString(),
        }
        await this.context.local.state.writeDeviceIssueReservation(value)
        return value
      }
    )

    let finalized = false
    try {
      // 已有 Device/Token 的准入拒绝必须发生在 Keychain/fallback 探测前。
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
        generation: randomUUID(),
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
        deliveryVerificationAttemptedAt: null,
        terminalEvidence: null,
      }
      await this.context.local.state.withAuthLock(async () => {
        const current =
          await this.context.local.state.readDeviceIssueReservation()
        if (
          !current ||
          current.ownerToken !== reservation.ownerToken ||
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
          snapshot.pollAttempt ||
          snapshot.cleanupReservation
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
      if (!finalized) await this.releaseIssueReservation(ownerToken)
    }
  }

  private async resumeDeviceAuthorizationWithRecoverySignal(
    global: GlobalOptions
  ): Promise<DeviceResumeResult> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const preparation = await this.devicePoll.prepare()
      if (preparation.kind === "reinspect") {
        const recovered = await this.context.local.inspectAndRecover()
        if (recovered.state === "device_only" || recovered.state === "none") {
          // index 可能在 prepare 释放锁后被另一进程收敛。重新走
          // prepare 才能让 delivery tombstone 返回 exit 5，不能误报用法错误。
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
          recoveredResponse: false,
        }
      }
      if (preparation.kind === "wait") {
        return {
          outcome: oauthWaitOutcome(
            localRequestId(),
            "authorization_pending",
            preparation.retryAfterSeconds
          ),
          recoveredResponse: false,
        }
      }
      if (preparation.kind === "recovered_response") {
        return {
          outcome: this.recoveredAcknowledgementOutcome({
            kind: "response",
            responseKind: preparation.responseKind,
            retryAfterSeconds: preparation.retryAfterSeconds,
          }),
          recoveredResponse: true,
        }
      }
      if (preparation.kind === "recovered_unknown") {
        throw outcomeUnknownFailure(
          "A previous Device Token request may have been dispatched before the process stopped. The state was fenced as delivery_unknown and was not replayed.",
          {
            deliveryState: "delivery_unknown",
            safeRestartAt: preparation.safeRestartAt,
          }
        )
      }
      const frozen = await this.devicePoll.freezeBackend(preparation)
      const dispatched = await this.devicePoll.markDispatchIntent(frozen)
      return {
        outcome: await this.pollToken(dispatched, global),
        recoveredResponse: false,
      }
    }
    throw dependencyFailure(
      "Local authentication state changed repeatedly while authorization was resuming."
    )
  }

  private recoveredAcknowledgementOutcome(
    recovery: DevicePollAcknowledgedRecovery
  ): CliOutcome {
    if (recovery.kind === "delivery_unknown") {
      throw outcomeUnknownFailure(
        "A previous Device Token request may have been dispatched before the process stopped. The state was fenced as delivery_unknown and was not replayed.",
        {
          deliveryState: "delivery_unknown",
          safeRestartAt: recovery.safeRestartAt,
        }
      )
    }
    if (
      recovery.responseKind === "authorization_pending" ||
      recovery.responseKind === "slow_down"
    ) {
      return oauthWaitOutcome(
        localRequestId(),
        recovery.responseKind,
        recovery.retryAfterSeconds
      )
    }
    if (recovery.responseKind === "temporarily_unavailable") {
      throw dependencyFailure(
        "The authorization service is temporarily unavailable.",
        EXIT_CODE.retryable,
        {
          retryAfterSeconds: recovery.retryAfterSeconds,
          oauthError: "temporarily_unavailable",
          suggestedAction: "retry_after",
        }
      )
    }
    throw dependencyFailure(
      "The authorization server rejected the Token request.",
      EXIT_CODE.business,
      { responseKind: "oauth_error" }
    )
  }

  private async pollToken(
    poll: FrozenDevicePoll,
    global: GlobalOptions
  ): Promise<CliOutcome> {
    const device = poll.device
    const deliveryVerification = poll.attempt.deliveryVerification
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
      this.assertPollCompletion(
        await this.devicePoll.completeDeliveryUnknown(
          poll,
          this.context.now().toISOString()
        )
      )
      throw outcomeUnknownFailure(
        "The Device Token exchange outcome is unknown. Do not blindly retry the original exchange.",
        {
          deliveryState: "delivery_unknown",
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
      deliveryVerification,
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
      this.assertPollCompletion(
        await this.devicePoll.completeDeliveryUnknown(poll, receivedAt)
      )
      throw outcomeUnknownFailure(
        classification.responseKind === "invalid_success"
          ? "The Device Token response was invalid; delivery may have occurred."
          : "The Device Token server returned a non-JSON failure; delivery is unknown.",
        { deliveryState: "delivery_unknown" }
      )
    }
    if (classification.kind === "terminal") {
      this.assertPollCompletion(
        await this.devicePoll.completeTerminal(poll, receivedAt)
      )
      throw authenticationFailure(
        deliveryVerification
          ? "The one-time Device authorization is no longer usable."
          : classification.oauthError === "access_denied"
            ? "The Owner denied this Device Authorization."
            : "The Device Authorization expired or was already consumed."
      )
    }
    if (classification.kind === "verification_unknown") {
      this.assertPollCompletion(
        await this.devicePoll.completeAcknowledgedResponse(
          poll,
          acknowledgedResponseKind(classification.oauthError),
          receivedAt,
          classification.protocolIntervalSeconds,
          classification.nextPollDelaySeconds,
          classification.retryAfterSeconds
        )
      )
      throw outcomeUnknownFailure(
        "The single delivery verification did not recover a Token. No further exchange will be sent before the safety boundary.",
        {
          deliveryState: "delivery_unknown",
          oauthError: classification.oauthError,
        }
      )
    }
    if (classification.kind === "pending") {
      this.assertPollCompletion(
        await this.devicePoll.completeAcknowledgedResponse(
          poll,
          "authorization_pending",
          receivedAt,
          classification.protocolIntervalSeconds
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
        await this.devicePoll.completeAcknowledgedResponse(
          poll,
          "slow_down",
          receivedAt,
          classification.protocolIntervalSeconds,
          classification.protocolIntervalSeconds,
          classification.retryAfterSeconds
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
        await this.devicePoll.completeAcknowledgedResponse(
          poll,
          "temporarily_unavailable",
          receivedAt,
          classification.protocolIntervalSeconds,
          classification.nextPollDelaySeconds,
          classification.retryAfterSeconds
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
        await this.devicePoll.completeAcknowledgedResponse(
          poll,
          "oauth_error",
          receivedAt,
          classification.protocolIntervalSeconds
        )
      )
      throw dependencyFailure(
        "The OAuth slow_down response has an invalid Retry-After value.",
        EXIT_CODE.business
      )
    }
    this.assertPollCompletion(
      await this.devicePoll.completeAcknowledgedResponse(
        poll,
        acknowledgedResponseKind(classification.oauthError),
        receivedAt,
        device.intervalSeconds
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
        "Device poll ownership changed while the response was being finalized; no current state was modified."
      )
    }
  }

  private async releaseIssueReservation(ownerToken: string): Promise<void> {
    await this.context.local.state.withAuthLock(async () => {
      const current =
        await this.context.local.state.readDeviceIssueReservation()
      if (current?.ownerToken === ownerToken) {
        await this.context.local.state.clearDeviceIssueReservation()
      }
    })
  }
}
