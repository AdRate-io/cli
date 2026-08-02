import { randomUUID } from "node:crypto"
import {
  DEVICE_DELIVERY_SAFETY_WINDOW_MS,
  DEVICE_TRANSACTION_LEASE_MS,
} from "../constants.js"
import {
  authenticationFailure,
  dependencyFailure,
  outcomeUnknownFailure,
  usageFailure,
} from "../errors.js"
import {
  issueReservationMatchesDevice,
  pollAttemptMatchesDevice,
  pollAttemptsEqual,
} from "./device-state-contract.js"
import {
  resolveSlowDownProtocolInterval,
  resolveTemporaryUnavailablePollSchedule,
} from "./device-poll-backoff.js"
import type {
  LocalAuthSnapshot,
  LocalCredentialCoordinator,
} from "./local-credentials.js"
import type {
  AuthCleanupReservation,
  DeviceAuthorizationState,
  DevicePollAcknowledgedResponseKind,
  DevicePollAttempt,
  DevicePollResponseAcknowledgement,
} from "../storage/schemas.js"

export type DevicePollPreparation =
  | { kind: "reinspect" }
  | { kind: "wait"; retryAfterSeconds: number }
  | {
      kind: "recovered_response"
      responseKind: DevicePollAcknowledgedResponseKind
      retryAfterSeconds: number
    }
  | { kind: "recovered_unknown"; safeRestartAt: string }
  | {
      kind: "select_backend"
      attempt: DevicePollAttempt
      device: DeviceAuthorizationState
    }

export interface FrozenDevicePoll {
  attempt: DevicePollAttempt
  device: DeviceAuthorizationState
}

interface SettledAcknowledgedResponse {
  acknowledgement: DevicePollResponseAcknowledgement
  deliveryVerification: boolean
  safeRestartAt: string | null
}

export type DevicePollAcknowledgedRecovery =
  | {
      kind: "response"
      responseKind: DevicePollAcknowledgedResponseKind
      retryAfterSeconds: number
    }
  | { kind: "delivery_unknown"; safeRestartAt: string }

export type LogoutPollNormalization =
  | { kind: "cleanup_pending"; reservation: AuthCleanupReservation }
  | { kind: "credential_pending" }
  | { kind: "none" }
  | { kind: "in_flight"; retryAfterSeconds: number }
  | { kind: "cleared_predispatch" }
  | { kind: "delivery_unknown"; safeRestartAt: string }

function addMilliseconds(iso: string, milliseconds: number): string {
  return new Date(new Date(iso).getTime() + milliseconds).toISOString()
}

function addSeconds(iso: string, seconds: number): string {
  return addMilliseconds(iso, seconds * 1000)
}

function secondsUntil(nowMs: number, futureIso: string): number {
  return Math.max(1, Math.ceil((new Date(futureIso).getTime() - nowMs) / 1000))
}

function attemptMatches(
  current: DevicePollAttempt | null,
  expected: DevicePollAttempt
): current is DevicePollAttempt {
  return current !== null && pollAttemptsEqual(current, expected)
}

function laterIso(left: string, right: string): string {
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right
}

function acknowledgementMatchesDeviceState(
  attempt: DevicePollAttempt,
  device: DeviceAuthorizationState,
  acknowledgement: DevicePollResponseAcknowledgement
): boolean {
  let expectedProtocolIntervalSeconds: number
  let expectedNextPollAt: string
  try {
    if (acknowledgement.responseKind === "slow_down") {
      if (
        acknowledgement.retryAfterSeconds === null &&
        !attempt.deliveryVerification
      ) {
        return false
      }
      expectedProtocolIntervalSeconds = resolveSlowDownProtocolInterval({
        previousProtocolIntervalSeconds:
          acknowledgement.previousProtocolIntervalSeconds,
        retryAfterSeconds:
          acknowledgement.retryAfterSeconds ??
          Math.min(30, acknowledgement.previousProtocolIntervalSeconds + 5),
      })
      expectedNextPollAt = addSeconds(
        acknowledgement.responseReceivedAt,
        expectedProtocolIntervalSeconds
      )
    } else if (acknowledgement.responseKind === "temporarily_unavailable") {
      const schedule = resolveTemporaryUnavailablePollSchedule({
        responseReceivedAt: acknowledgement.responseReceivedAt,
        protocolIntervalSeconds:
          acknowledgement.previousProtocolIntervalSeconds,
        retryAfterSeconds: acknowledgement.retryAfterSeconds,
      })
      expectedProtocolIntervalSeconds = schedule.protocolIntervalSeconds
      expectedNextPollAt = schedule.nextPollAt
    } else {
      if (acknowledgement.retryAfterSeconds !== null) return false
      expectedProtocolIntervalSeconds =
        acknowledgement.previousProtocolIntervalSeconds
      expectedNextPollAt = addSeconds(
        acknowledgement.responseReceivedAt,
        expectedProtocolIntervalSeconds
      )
    }
  } catch {
    return false
  }
  if (
    acknowledgement.protocolIntervalSeconds !==
      expectedProtocolIntervalSeconds ||
    acknowledgement.nextPollAt !== expectedNextPollAt
  ) {
    return false
  }

  const dispatchedAtMs =
    attempt.dispatchedAt === null
      ? Number.NaN
      : new Date(attempt.dispatchedAt).getTime()
  const deviceNextPollAtMs = new Date(device.nextPollAt).getTime()
  const isBeforeApply =
    device.intervalSeconds ===
      acknowledgement.previousProtocolIntervalSeconds &&
    Number.isFinite(dispatchedAtMs) &&
    deviceNextPollAtMs <= dispatchedAtMs
  const isAfterApply =
    device.intervalSeconds === acknowledgement.protocolIntervalSeconds &&
    device.nextPollAt === acknowledgement.nextPollAt
  return isBeforeApply || isAfterApply
}

export class DevicePollCoordinator {
  constructor(
    private readonly local: LocalCredentialCoordinator,
    private readonly now: () => Date
  ) {}

  async prepare(): Promise<DevicePollPreparation> {
    const recoveredAcknowledgement = await this.recoverAcknowledgedResponse()
    if (recoveredAcknowledgement?.kind === "delivery_unknown") {
      return {
        kind: "recovered_unknown",
        safeRestartAt: recoveredAcknowledgement.safeRestartAt,
      }
    }
    if (recoveredAcknowledgement?.kind === "response") {
      return {
        kind: "recovered_response",
        responseKind: recoveredAcknowledgement.responseKind,
        retryAfterSeconds: recoveredAcknowledgement.retryAfterSeconds,
      }
    }
    // terminal 墓碑的收敛不依赖 OS 进程探测；即使 probe 故障，
    // 已确认的终态也必须能幂等删除且绝不发 Token POST。
    if ((await this.local.state.readDeviceState())?.localState === "terminal") {
      await this.local.state.withAuthLock(async () => {
        await this.local.settleTerminalDeviceLocked(
          await this.local.readLocalSnapshotLocked()
        )
      })
      throw authenticationFailure(
        "The Device Authorization reached a terminal state. Start a new Device flow."
      )
    }
    // 在取得状态锁前解析稳定进程实例，避免把 OS 探测放进短事务锁。
    const processIdentity = await this.local.storageCommitProcessIdentity()
    return this.local.state.withAuthLock(async () => {
      let snapshot = await this.local.readLocalSnapshotLocked()
      if (snapshot.cleanupReservation) {
        throw usageFailure(
          "Another local authentication transaction is already in progress."
        )
      }
      if (snapshot.issueReservation) {
        const age =
          this.now().getTime() -
          new Date(snapshot.issueReservation.createdAt).getTime()
        if (
          age < DEVICE_TRANSACTION_LEASE_MS ||
          !snapshot.device ||
          snapshot.index ||
          snapshot.metadata ||
          snapshot.fallbackExists ||
          snapshot.pollAttempt ||
          !issueReservationMatchesDevice(
            snapshot.issueReservation,
            snapshot.device
          )
        ) {
          throw usageFailure(
            "Another local authentication transaction is already in progress."
          )
        }
        // Device 已落盘即证明发码响应已完成。进程在同一锁内
        // 清 reservation 前崩溃时，租约到期后只清该精确绑定的残留。
        await this.local.state.clearDeviceIssueReservation()
        snapshot = await this.local.readLocalSnapshotLocked()
      }
      if (snapshot.index) return { kind: "reinspect" }
      snapshot = await this.local.settleTerminalDeviceLocked(snapshot)

      const now = this.now()
      const nowMs = now.getTime()
      let device = snapshot.device
      const existingAttempt = snapshot.pollAttempt
      if (existingAttempt) {
        if (existingAttempt.phase === "response_acknowledged") {
          const acknowledgement =
            await this.settleAcknowledgedResponseLocked(snapshot)
          if (acknowledgement.deliveryVerification) {
            return {
              kind: "recovered_unknown",
              safeRestartAt: acknowledgement.safeRestartAt!,
            }
          }
          return {
            kind: "recovered_response",
            responseKind: acknowledgement.acknowledgement.responseKind,
            retryAfterSeconds: secondsUntil(
              nowMs,
              acknowledgement.acknowledgement.nextPollAt
            ),
          }
        } else if (
          !device ||
          !pollAttemptMatchesDevice(existingAttempt, device)
        ) {
          if (new Date(existingAttempt.leaseExpiresAt).getTime() > nowMs) {
            return {
              kind: "wait",
              retryAfterSeconds: secondsUntil(
                nowMs,
                existingAttempt.leaseExpiresAt
              ),
            }
          }
          if (existingAttempt.phase !== "dispatch_intent") {
            await this.local.state.clearDevicePollAttempt()
          }
          throw dependencyFailure(
            "The previous Device poll attempt does not match the current Device generation."
          )
        } else if (new Date(existingAttempt.leaseExpiresAt).getTime() > nowMs) {
          return {
            kind: "wait",
            retryAfterSeconds: secondsUntil(
              nowMs,
              existingAttempt.leaseExpiresAt
            ),
          }
        } else if (existingAttempt.phase === "dispatch_intent") {
          const recovered = await this.recoverDispatchIntent(
            device,
            existingAttempt
          )
          return {
            kind: "recovered_unknown",
            safeRestartAt: recovered.safeRestartAt,
          }
        } else {
          await this.local.state.clearDevicePollAttempt()
        }
      }

      device = await this.local.state.readDeviceState()
      if (!device) {
        throw authenticationFailure(
          "No Device Authorization is available to resume."
        )
      }
      if (
        !snapshot.config ||
        snapshot.config.environment !== device.environment ||
        snapshot.config.issuerOrigin !== device.issuerOrigin ||
        snapshot.config.clientInstanceId !== device.clientInstanceId
      ) {
        throw usageFailure(
          "The local Device Authorization does not match config.json.",
          { reason: "metadata_mismatch" }
        )
      }
      if (device.localState === "token_received") {
        throw outcomeUnknownFailure(
          "A Token was received but its secure location is unavailable."
        )
      }

      const expiresMs = new Date(device.expiresAt).getTime()
      let deliveryVerification = false
      if (
        device.localState === "delivery_unknown" &&
        device.deliveryVerificationAttemptedAt !== null
      ) {
        const attemptedMs = new Date(
          device.deliveryVerificationAttemptedAt
        ).getTime()
        if (nowMs < attemptedMs) {
          throw outcomeUnknownFailure(
            "The local clock moved behind the delivery verification timestamp; no network request was sent."
          )
        }
        const safeRestartAt = Math.max(
          expiresMs,
          attemptedMs + DEVICE_DELIVERY_SAFETY_WINDOW_MS
        )
        if (nowMs < safeRestartAt) {
          throw outcomeUnknownFailure(
            "The one allowed delivery verification was already used; wait before starting a new Device flow.",
            { safeRestartAt: new Date(safeRestartAt).toISOString() }
          )
        }
        await this.local.state.clearDeviceState()
        throw authenticationFailure(
          "The delivery verification safety window ended. Start a new Device flow."
        )
      }
      if (nowMs >= expiresMs) {
        await this.local.state.clearDeviceState()
        throw authenticationFailure("The Device Authorization has expired.")
      }
      if (nowMs < new Date(device.nextPollAt).getTime()) {
        return {
          kind: "wait",
          retryAfterSeconds: secondsUntil(nowMs, device.nextPollAt),
        }
      }
      if (device.localState === "delivery_unknown") {
        deliveryVerification = true
      }

      const createdAt = now.toISOString()
      const attempt: DevicePollAttempt = {
        formatVersion: 1,
        ownerToken: randomUUID(),
        deviceGeneration: device.generation,
        environment: device.environment,
        issuerOrigin: device.issuerOrigin,
        clientInstanceId: device.clientInstanceId,
        phase: "selecting_backend",
        deliveryVerification,
        storageKind: null,
        ownerPid: processIdentity.pid,
        ownerProcessFingerprint: processIdentity.fingerprint,
        createdAt,
        dispatchedAt: null,
        verificationClaimedAt: null,
        responseAcknowledgement: null,
        leaseExpiresAt: addMilliseconds(createdAt, DEVICE_TRANSACTION_LEASE_MS),
      }
      await this.local.state.writeDevicePollAttempt(attempt)
      return { kind: "select_backend", attempt, device }
    })
  }

  /**
   * 所有 auth 命令共用的 response_acknowledged 单调恢复入口。
   * 它只完成已冻结响应的 Device 更新和 attempt 删除，不发网络请求。
   */
  async recoverAcknowledgedResponse(): Promise<DevicePollAcknowledgedRecovery | null> {
    const recovered = await this.local.state.withAuthLock(async () => {
      const pollAttempt = await this.local.state.readDevicePollAttempt()
      if (pollAttempt?.phase !== "response_acknowledged") {
        return null
      }
      if (await this.local.state.readAuthCleanupReservation()) return null
      const snapshot = await this.local.readLocalSnapshotLocked()
      return this.settleAcknowledgedResponseLocked(snapshot)
    })
    if (!recovered) return null
    if (recovered.deliveryVerification) {
      return {
        kind: "delivery_unknown",
        safeRestartAt: recovered.safeRestartAt!,
      }
    }
    return {
      kind: "response",
      responseKind: recovered.acknowledgement.responseKind,
      retryAfterSeconds: secondsUntil(
        this.now().getTime(),
        recovered.acknowledgement.nextPollAt
      ),
    }
  }

  async normalizeForLogout(): Promise<LogoutPollNormalization> {
    return this.local.state.withAuthLock(async () => {
      // cleanup reservation 是已持久化的单调事务。它的恢复优先级
      // 高于 poll lease 和 delivery tombstone，否则部分剪枝后留下的
      // Device/poll 组合可能使 logout 永久无法进入清理续作。
      const cleanupReservation =
        await this.local.state.readAuthCleanupReservation()
      if (cleanupReservation) {
        return { kind: "cleanup_pending", reservation: cleanupReservation }
      }
      if (await this.local.state.readTokenIndex()) {
        return { kind: "credential_pending" }
      }
      let snapshot = await this.local.readLocalSnapshotLocked()
      const hadTerminal = snapshot.device?.localState === "terminal"
      snapshot = await this.local.settleTerminalDeviceLocked(snapshot)
      if (hadTerminal) return { kind: "cleared_predispatch" }
      const attempt = snapshot.pollAttempt
      if (!attempt) return { kind: "none" }
      if (attempt.phase === "response_acknowledged") {
        const acknowledgement =
          await this.settleAcknowledgedResponseLocked(snapshot)
        if (acknowledgement.deliveryVerification) {
          return {
            kind: "delivery_unknown",
            safeRestartAt: acknowledgement.safeRestartAt!,
          }
        }
        return { kind: "cleared_predispatch" }
      }
      const now = this.now()
      const nowMs = now.getTime()
      if (new Date(attempt.leaseExpiresAt).getTime() > nowMs) {
        return {
          kind: "in_flight",
          retryAfterSeconds: secondsUntil(nowMs, attempt.leaseExpiresAt),
        }
      }
      const device = snapshot.device
      if (!device || !pollAttemptMatchesDevice(attempt, device)) {
        throw dependencyFailure(
          "The expired Device poll attempt does not match the current Device generation."
        )
      }
      if (attempt.phase !== "dispatch_intent") {
        await this.local.state.clearDevicePollAttempt()
        return { kind: "cleared_predispatch" }
      }
      const recovered = await this.recoverDispatchIntent(device, attempt)
      return {
        kind: "delivery_unknown",
        safeRestartAt: recovered.safeRestartAt,
      }
    })
  }

  async freezeBackend(
    preparation: Extract<DevicePollPreparation, { kind: "select_backend" }>
  ): Promise<FrozenDevicePoll> {
    let selection
    try {
      selection = await this.local.credentials.selectForNewCredential()
    } catch (error) {
      await this.abandonBeforeDispatch(preparation.attempt)
      throw error
    }
    const frozen = await this.local.state.withAuthLock(async () => {
      const currentAttempt = await this.local.state.readDevicePollAttempt()
      const currentDevice = await this.local.state.readDeviceState()
      if (
        !attemptMatches(currentAttempt, preparation.attempt) ||
        currentAttempt.phase !== "selecting_backend" ||
        !currentDevice ||
        !pollAttemptMatchesDevice(currentAttempt, currentDevice)
      ) {
        throw dependencyFailure(
          "Device poll ownership changed while secure storage was selected."
        )
      }
      const now = this.now().toISOString()
      if (
        new Date(now).getTime() < new Date(currentAttempt.createdAt).getTime()
      ) {
        throw dependencyFailure(
          "The local clock moved behind the Device poll attempt; no Token request was sent."
        )
      }
      const value: DevicePollAttempt = {
        ...currentAttempt,
        phase: "ready",
        storageKind: selection.backend.kind,
        leaseExpiresAt: addMilliseconds(now, DEVICE_TRANSACTION_LEASE_MS),
      }
      await this.local.state.writeDevicePollAttempt(value)
      return { attempt: value, device: currentDevice }
    })
    return {
      ...frozen,
    }
  }

  async markDispatchIntent(input: FrozenDevicePoll): Promise<FrozenDevicePoll> {
    return this.local.state.withAuthLock(async () => {
      const currentAttempt = await this.local.state.readDevicePollAttempt()
      const currentDevice = await this.local.state.readDeviceState()
      if (
        !attemptMatches(currentAttempt, input.attempt) ||
        currentAttempt.phase !== "ready" ||
        currentAttempt.storageKind === null ||
        !currentDevice ||
        !pollAttemptMatchesDevice(currentAttempt, currentDevice)
      ) {
        throw dependencyFailure(
          "Device poll ownership changed before the Token request was dispatched."
        )
      }
      const dispatchedAt = this.now().toISOString()
      if (
        new Date(dispatchedAt).getTime() <
        new Date(currentAttempt.createdAt).getTime()
      ) {
        throw dependencyFailure(
          "The local clock moved behind the Device poll attempt; no Token request was sent."
        )
      }
      const dispatched: DevicePollAttempt = {
        ...currentAttempt,
        phase: "dispatch_intent",
        dispatchedAt,
        verificationClaimedAt: currentAttempt.deliveryVerification
          ? dispatchedAt
          : null,
        responseAcknowledgement: null,
        leaseExpiresAt: addMilliseconds(
          dispatchedAt,
          DEVICE_TRANSACTION_LEASE_MS
        ),
      }
      await this.local.state.writeDevicePollAttempt(dispatched)
      const polling: DeviceAuthorizationState = {
        ...currentDevice,
        localState: currentAttempt.deliveryVerification
          ? "delivery_unknown"
          : "polling",
        deliveryVerificationAttemptedAt: currentAttempt.deliveryVerification
          ? dispatched.verificationClaimedAt
          : currentDevice.deliveryVerificationAttemptedAt,
      }
      await this.local.state.writeDeviceState(polling)
      return {
        attempt: dispatched,
        device: polling,
      }
    })
  }

  completeAcknowledgedResponse(
    input: FrozenDevicePoll,
    responseKind: DevicePollAcknowledgedResponseKind,
    receivedAt: string,
    protocolIntervalSeconds: number,
    nextPollDelaySeconds = protocolIntervalSeconds,
    retryAfterSeconds: number | null = null
  ): Promise<boolean> {
    this.assertCompletionTimestamp(input.attempt, receivedAt)
    return this.local.state.withAuthLock(async () => {
      const currentAttempt = await this.local.state.readDevicePollAttempt()
      const currentDevice = await this.local.state.readDeviceState()
      if (
        !attemptMatches(currentAttempt, input.attempt) ||
        currentAttempt.phase !== "dispatch_intent" ||
        !currentDevice ||
        !pollAttemptMatchesDevice(currentAttempt, currentDevice) ||
        currentDevice.localState === "token_received" ||
        currentDevice.localState === "terminal"
      ) {
        return false
      }
      const responseAcknowledgement: DevicePollResponseAcknowledgement = {
        responseKind,
        responseReceivedAt: receivedAt,
        previousProtocolIntervalSeconds: input.device.intervalSeconds,
        protocolIntervalSeconds,
        retryAfterSeconds,
        nextPollAt: addSeconds(receivedAt, nextPollDelaySeconds),
      }
      const acknowledgedAttempt: DevicePollAttempt = {
        ...currentAttempt,
        phase: "response_acknowledged",
        responseAcknowledgement,
      }
      if (
        !acknowledgementMatchesDeviceState(
          acknowledgedAttempt,
          currentDevice,
          responseAcknowledgement
        )
      ) {
        throw dependencyFailure(
          "The Device poll response acknowledgement does not match the frozen polling schedule."
        )
      }
      // 单调提交顺序：先冻结响应事实，再幂等更新 Device，
      // 最后删除 attempt。两个写后崩溃都由 prepare/logout 纯本地续作。
      await this.local.state.writeDevicePollAttempt(acknowledgedAttempt)
      await this.applyAcknowledgedResponseLocked(
        currentDevice,
        acknowledgedAttempt
      )
      await this.local.state.clearDevicePollAttempt()
      return true
    })
  }

  completeDeliveryUnknown(
    input: FrozenDevicePoll,
    requestEndedAt: string
  ): Promise<boolean> {
    this.assertCompletionTimestamp(input.attempt, requestEndedAt)
    return this.completeOwned(input.attempt, async (device) => {
      await this.local.state.writeDeviceState({
        ...device,
        localState: "delivery_unknown",
        nextPollAt: addSeconds(requestEndedAt, device.intervalSeconds),
        deliveryVerificationAttemptedAt:
          device.deliveryVerificationAttemptedAt ??
          input.attempt.verificationClaimedAt,
      })
    })
  }

  completeTerminal(
    input: FrozenDevicePoll,
    acknowledgedAt: string
  ): Promise<boolean> {
    this.assertCompletionTimestamp(input.attempt, acknowledgedAt)
    return this.local.state.withAuthLock(async () => {
      const currentAttempt = await this.local.state.readDevicePollAttempt()
      const currentDevice = await this.local.state.readDeviceState()
      if (
        !attemptMatches(currentAttempt, input.attempt) ||
        currentAttempt.phase !== "dispatch_intent" ||
        !currentDevice ||
        !pollAttemptMatchesDevice(currentAttempt, currentDevice)
      ) {
        return false
      }
      // 先持久化完整 dispatch 证据的显式 terminal 墓碑，再删
      // attempt，最后删 Device。任一步崩溃后 prepare/logout/status
      // 都只会删除该冻结 attempt 原值，绝不再发 Token POST。
      await this.local.state.writeDeviceState({
        ...currentDevice,
        localState: "terminal",
        deviceCode: null,
        userCode: null,
        deliveryVerificationAttemptedAt: null,
        terminalEvidence: {
          acknowledgedAt,
          attempt: currentAttempt,
        },
      })
      await this.local.state.clearDevicePollAttempt()
      await this.local.state.clearDeviceState()
      return true
    })
  }

  async abandonBeforeDispatch(attempt: DevicePollAttempt): Promise<void> {
    await this.local.state.withAuthLock(async () => {
      const current = await this.local.state.readDevicePollAttempt()
      if (
        current?.ownerToken === attempt.ownerToken &&
        current.deviceGeneration === attempt.deviceGeneration &&
        (current.phase === "selecting_backend" || current.phase === "ready")
      ) {
        await this.local.state.clearDevicePollAttempt()
      }
    })
  }

  private async completeOwned(
    attempt: DevicePollAttempt,
    update: (device: DeviceAuthorizationState) => Promise<void>
  ): Promise<boolean> {
    return this.local.state.withAuthLock(async () => {
      const currentAttempt = await this.local.state.readDevicePollAttempt()
      const currentDevice = await this.local.state.readDeviceState()
      if (
        !attemptMatches(currentAttempt, attempt) ||
        currentAttempt.phase !== "dispatch_intent" ||
        !currentDevice ||
        !pollAttemptMatchesDevice(currentAttempt, currentDevice)
      ) {
        return false
      }
      await update(currentDevice)
      await this.local.state.clearDevicePollAttempt()
      return true
    })
  }

  private async settleAcknowledgedResponseLocked(
    snapshot: LocalAuthSnapshot
  ): Promise<SettledAcknowledgedResponse> {
    const attempt = snapshot.pollAttempt
    const acknowledgement = attempt?.responseAcknowledgement
    const device = snapshot.device
    if (
      !attempt ||
      attempt.phase !== "response_acknowledged" ||
      !acknowledgement ||
      !device ||
      !pollAttemptMatchesDevice(attempt, device) ||
      snapshot.index ||
      snapshot.metadata ||
      snapshot.fallbackExists ||
      snapshot.issueReservation ||
      snapshot.cleanupReservation ||
      !snapshot.config ||
      snapshot.config.environment !== device.environment ||
      snapshot.config.issuerOrigin !== device.issuerOrigin ||
      snapshot.config.clientInstanceId !== device.clientInstanceId ||
      device.localState === "token_received" ||
      device.localState === "terminal" ||
      device.deviceCode === null ||
      device.userCode === null ||
      device.terminalEvidence !== null
    ) {
      throw dependencyFailure(
        "The acknowledged Device poll response conflicts with current local authentication evidence."
      )
    }
    const settledDevice = await this.applyAcknowledgedResponseLocked(
      device,
      attempt
    )
    const attemptedAt = settledDevice.deliveryVerificationAttemptedAt
    if (attempt.deliveryVerification && attemptedAt === null) {
      throw dependencyFailure(
        "The acknowledged delivery verification is missing its persisted claim timestamp."
      )
    }
    await this.local.state.clearDevicePollAttempt()
    return {
      acknowledgement,
      deliveryVerification: attempt.deliveryVerification,
      safeRestartAt:
        attempt.deliveryVerification && attemptedAt !== null
          ? new Date(
              Math.max(
                new Date(settledDevice.expiresAt).getTime(),
                new Date(attemptedAt).getTime() +
                  DEVICE_DELIVERY_SAFETY_WINDOW_MS
              )
            ).toISOString()
          : null,
    }
  }

  private async applyAcknowledgedResponseLocked(
    device: DeviceAuthorizationState,
    attempt: DevicePollAttempt
  ): Promise<DeviceAuthorizationState> {
    const acknowledgement = attempt.responseAcknowledgement
    if (attempt.phase !== "response_acknowledged" || acknowledgement === null) {
      throw dependencyFailure(
        "The Device poll response acknowledgement is incomplete."
      )
    }
    if (!acknowledgementMatchesDeviceState(attempt, device, acknowledgement)) {
      throw dependencyFailure(
        "The Device poll response acknowledgement conflicts with the current Device polling schedule."
      )
    }
    const settled: DeviceAuthorizationState = {
      ...device,
      localState: attempt.deliveryVerification ? "delivery_unknown" : "polling",
      intervalSeconds: acknowledgement.protocolIntervalSeconds,
      nextPollAt: acknowledgement.nextPollAt,
      deliveryVerificationAttemptedAt: attempt.deliveryVerification
        ? (device.deliveryVerificationAttemptedAt ??
          attempt.verificationClaimedAt)
        : device.deliveryVerificationAttemptedAt,
    }
    await this.local.state.writeDeviceState(settled)
    return settled
  }

  private async recoverDispatchIntent(
    device: DeviceAuthorizationState,
    attempt: DevicePollAttempt
  ): Promise<{
    device: DeviceAuthorizationState
    safeRestartAt: string
  }> {
    if (attempt.dispatchedAt === null) {
      throw dependencyFailure(
        "The dispatched Device poll attempt is missing its dispatch timestamp."
      )
    }
    if (
      device.localState === "token_received" ||
      device.localState === "terminal" ||
      device.deviceCode === null ||
      device.userCode === null ||
      device.terminalEvidence !== null
    ) {
      throw dependencyFailure(
        "The dispatched Device poll attempt cannot be recovered from the current Device state."
      )
    }
    const recovered: DeviceAuthorizationState = {
      ...device,
      localState: "delivery_unknown",
      nextPollAt: laterIso(
        device.nextPollAt,
        addSeconds(attempt.dispatchedAt, device.intervalSeconds)
      ),
      deliveryVerificationAttemptedAt:
        device.deliveryVerificationAttemptedAt ?? attempt.verificationClaimedAt,
    }
    await this.local.state.writeDeviceState(recovered)
    await this.local.state.clearDevicePollAttempt()
    const attemptedAt = recovered.deliveryVerificationAttemptedAt
    const safeRestartAt =
      attemptedAt === null
        ? recovered.expiresAt
        : new Date(
            Math.max(
              new Date(recovered.expiresAt).getTime(),
              new Date(attemptedAt).getTime() + DEVICE_DELIVERY_SAFETY_WINDOW_MS
            )
          ).toISOString()
    return { device: recovered, safeRestartAt }
  }

  private assertCompletionTimestamp(
    attempt: DevicePollAttempt,
    completedAt: string
  ): void {
    const dispatchedAt = attempt.dispatchedAt
    const boundary = attempt.verificationClaimedAt ?? dispatchedAt
    if (
      attempt.phase !== "dispatch_intent" ||
      dispatchedAt === null ||
      boundary === null ||
      new Date(completedAt).getTime() < new Date(boundary).getTime()
    ) {
      throw outcomeUnknownFailure(
        "The local clock moved behind the persisted Device dispatch timestamp; the dispatched request was preserved without shortening its recovery boundary.",
        { deliveryState: "delivery_unknown" }
      )
    }
  }
}
