import type {
  DeviceAuthorizationState,
  DevicePollAttempt,
  TokenIndex,
} from "../storage/schemas.js"

/** Device/poll 的不可变业务绑定，不包含会随响应收敛的 Device 状态。 */
export function pollAttemptMatchesDevice(
  attempt: DevicePollAttempt,
  device: DeviceAuthorizationState
): boolean {
  return attempt.deviceGeneration === device.generation
}

export function pollAttemptsEqual(
  left: DevicePollAttempt,
  right: DevicePollAttempt
): boolean {
  return (
    left.deviceGeneration === right.deviceGeneration &&
    left.storageKind === right.storageKind
  )
}

/** TokenIndex 只收敛同一 Device generation 和存储位置的临时 staging。 */
export function pollAttemptMatchesIndex(
  attempt: DevicePollAttempt,
  index: TokenIndex
): boolean {
  return (
    attempt.deviceGeneration === index.deviceGeneration &&
    attempt.storageKind === index.storageKind
  )
}
