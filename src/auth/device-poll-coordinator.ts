import {
  authenticationFailure,
  dependencyFailure,
  outcomeUnknownFailure,
  usageFailure,
} from "../errors.js"
import {
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
  DeviceAuthorizationState,
  DevicePollAttempt,
} from "../storage/schemas.js"

export type DevicePollPreparation =
  | { kind: "reinspect" }
  | { kind: "wait"; retryAfterSeconds: number }
  | {
      kind: "select_backend"
      attempt: DevicePollAttempt
      device: DeviceAuthorizationState
    }

export interface FrozenDevicePoll {
  attempt: DevicePollAttempt
  device: DeviceAuthorizationState
}

export type LogoutPollNormalization =
  | { kind: "credential_pending" }
  | { kind: "none" }

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString()
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

export class DevicePollCoordinator {
  constructor(
    private readonly local: LocalCredentialCoordinator,
    private readonly now: () => Date
  ) {}

  /**
   * 上次进程留下的 poll staging 不代表可恢复的远端事务。若尚未形成凭据，
   * 丢弃同代 Device 并从新一轮发码开始；TokenIndex 已存在时交给凭据恢复处理。
   */
  async normalizeForLogin(): Promise<void> {
    await this.local.state.withAuthLock(async () => {
      const snapshot = await this.local.readLocalSnapshotLocked()
      if (snapshot.index) {
        return
      }
      if (snapshot.issueReservation && !snapshot.device) {
        await this.local.state.clearDeviceIssueReservation()
      }
      if (!snapshot.pollAttempt) return
      if (
        snapshot.device &&
        pollAttemptMatchesDevice(snapshot.pollAttempt, snapshot.device)
      ) {
        await this.local.state.clearDeviceState()
      }
      await this.local.state.clearDevicePollAttempt()
    })
  }

  async prepare(): Promise<DevicePollPreparation> {
    return this.local.state.withAuthLock(async () => {
      let snapshot = await this.local.readLocalSnapshotLocked()
      if (snapshot.issueReservation) {
        if (snapshot.device) {
          await this.local.state.clearDeviceIssueReservation()
          snapshot = await this.local.readLocalSnapshotLocked()
        } else {
          throw usageFailure(
            "Another local authentication transaction is already in progress."
          )
        }
      }
      if (snapshot.index) return { kind: "reinspect" }

      const now = this.now()
      const nowMs = now.getTime()
      const device = snapshot.device
      const existingAttempt = snapshot.pollAttempt
      if (existingAttempt) {
        if (!device || !pollAttemptMatchesDevice(existingAttempt, device)) {
          await this.local.state.clearDevicePollAttempt()
        } else {
          throw usageFailure(
            "Another Device Token exchange is already in progress."
          )
        }
      }

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

      const attempt: DevicePollAttempt = {
        formatVersion: 1,
        deviceGeneration: device.generation,
        storageKind: null,
      }
      await this.local.state.writeDevicePollAttempt(attempt)
      return { kind: "select_backend", attempt, device }
    })
  }

  async normalizeForLogout(): Promise<LogoutPollNormalization> {
    return this.local.state.withAuthLock(async () => {
      if (await this.local.state.readTokenIndex()) {
        return { kind: "credential_pending" }
      }
      const snapshot = await this.local.readLocalSnapshotLocked()
      if (snapshot.pollAttempt) {
        await this.local.state.clearDeviceState()
        await this.local.state.clearDevicePollAttempt()
      } else if (snapshot.device) {
        await this.local.state.clearDeviceState()
      }
      if (snapshot.issueReservation) {
        await this.local.state.clearDeviceIssueReservation()
      }
      return { kind: "none" }
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
    return this.local.state.withAuthLock(async () => {
      const currentAttempt = await this.local.state.readDevicePollAttempt()
      const currentDevice = await this.local.state.readDeviceState()
      if (
        !attemptMatches(currentAttempt, preparation.attempt) ||
        currentAttempt.storageKind !== null ||
        !currentDevice ||
        !pollAttemptMatchesDevice(currentAttempt, currentDevice)
      ) {
        throw dependencyFailure(
          "Device poll state changed while secure storage was selected."
        )
      }
      const value: DevicePollAttempt = {
        ...currentAttempt,
        storageKind: selection.backend.kind,
      }
      await this.local.state.writeDevicePollAttempt(value)
      const polling: DeviceAuthorizationState = {
        ...currentDevice,
        localState: "polling",
      }
      await this.local.state.writeDeviceState(polling)
      return {
        attempt: value,
        device: polling,
      }
    })
  }

  completePollResponse(
    input: FrozenDevicePoll,
    update: (device: DeviceAuthorizationState) => DeviceAuthorizationState
  ): Promise<boolean> {
    return this.local.state.withAuthLock(async () => {
      const currentAttempt = await this.local.state.readDevicePollAttempt()
      const currentDevice = await this.local.state.readDeviceState()
      if (
        !attemptMatches(currentAttempt, input.attempt) ||
        !currentDevice ||
        !pollAttemptMatchesDevice(currentAttempt, currentDevice) ||
        currentDevice.localState === "token_received"
      ) {
        return false
      }
      await this.stateWriteDevice(update(currentDevice))
      await this.local.state.clearDevicePollAttempt()
      return true
    })
  }

  completeTerminal(input: FrozenDevicePoll): Promise<boolean> {
    return this.local.state.withAuthLock(async () => {
      const currentAttempt = await this.local.state.readDevicePollAttempt()
      const currentDevice = await this.local.state.readDeviceState()
      if (
        !attemptMatches(currentAttempt, input.attempt) ||
        !currentDevice ||
        !pollAttemptMatchesDevice(currentAttempt, currentDevice)
      ) {
        return false
      }
      await this.local.state.clearDevicePollAttempt()
      await this.local.state.clearDeviceState()
      return true
    })
  }

  async abandonBeforeDispatch(attempt: DevicePollAttempt): Promise<void> {
    await this.local.state.withAuthLock(async () => {
      const current = await this.local.state.readDevicePollAttempt()
      if (attemptMatches(current, attempt)) {
        await this.local.state.clearDevicePollAttempt()
      }
    })
  }

  /** delivery 不确定时不保留不可恢复屏障；同代 Device 作废，下一次重新发码。 */
  async abandonUnknown(input: FrozenDevicePoll): Promise<void> {
    await this.local.state.withAuthLock(async () => {
      const currentAttempt = await this.local.state.readDevicePollAttempt()
      const currentDevice = await this.local.state.readDeviceState()
      if (
        currentDevice?.generation !== input.device.generation ||
        !attemptMatches(currentAttempt, input.attempt)
      ) {
        return
      }
      await this.local.state.clearDeviceState()
      await this.local.state.clearDevicePollAttempt()
    })
  }

  private stateWriteDevice(device: DeviceAuthorizationState): Promise<void> {
    return this.local.state.writeDeviceState(device)
  }

  /** 根据 OAuth 响应更新 Device 轮询调度。 */
  applyOAuthSchedule(
    device: DeviceAuthorizationState,
    receivedAt: string,
    responseKind:
      | "authorization_pending"
      | "slow_down"
      | "temporarily_unavailable"
      | "oauth_error",
    protocolIntervalSeconds: number,
    nextPollDelaySeconds = protocolIntervalSeconds,
    retryAfterSeconds: number | null = null
  ): DeviceAuthorizationState {
    if (responseKind === "slow_down") {
      const interval = resolveSlowDownProtocolInterval({
        previousProtocolIntervalSeconds: device.intervalSeconds,
        retryAfterSeconds:
          retryAfterSeconds ??
          Math.min(30, device.intervalSeconds + 5),
      })
      return {
        ...device,
        localState: "polling",
        intervalSeconds: interval,
        nextPollAt: addSeconds(receivedAt, interval),
      }
    }
    if (responseKind === "temporarily_unavailable") {
      const schedule = resolveTemporaryUnavailablePollSchedule({
        responseReceivedAt: receivedAt,
        protocolIntervalSeconds,
        retryAfterSeconds,
      })
      return {
        ...device,
        localState: "polling",
        intervalSeconds: schedule.protocolIntervalSeconds,
        nextPollAt: schedule.nextPollAt,
      }
    }
    return {
      ...device,
      localState: "polling",
      intervalSeconds: protocolIntervalSeconds,
      nextPollAt: addSeconds(receivedAt, nextPollDelaySeconds),
    }
  }
}
