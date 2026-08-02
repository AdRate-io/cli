import type {
  DeviceAuthorizationState,
  DeviceIssueReservation,
  DevicePollAttempt,
  TokenIndex,
} from "../storage/schemas.js"

/** Device/poll 的不可变业务绑定，不包含会随响应收敛的 Device 状态。 */
export function pollAttemptMatchesDevice(
  attempt: DevicePollAttempt,
  device: DeviceAuthorizationState
): boolean {
  return (
    attempt.deviceGeneration === device.generation &&
    attempt.environment === device.environment &&
    attempt.issuerOrigin === device.issuerOrigin &&
    attempt.clientInstanceId === device.clientInstanceId
  )
}

export function pollAttemptsEqual(
  left: DevicePollAttempt,
  right: DevicePollAttempt
): boolean {
  const leftAcknowledgement = left.responseAcknowledgement
  const rightAcknowledgement = right.responseAcknowledgement
  return (
    left.ownerToken === right.ownerToken &&
    left.deviceGeneration === right.deviceGeneration &&
    left.environment === right.environment &&
    left.issuerOrigin === right.issuerOrigin &&
    left.clientInstanceId === right.clientInstanceId &&
    left.phase === right.phase &&
    left.deliveryVerification === right.deliveryVerification &&
    left.storageKind === right.storageKind &&
    left.ownerPid === right.ownerPid &&
    left.ownerProcessFingerprint === right.ownerProcessFingerprint &&
    left.createdAt === right.createdAt &&
    left.dispatchedAt === right.dispatchedAt &&
    left.verificationClaimedAt === right.verificationClaimedAt &&
    left.leaseExpiresAt === right.leaseExpiresAt &&
    (leftAcknowledgement === null
      ? rightAcknowledgement === null
      : rightAcknowledgement !== null &&
        leftAcknowledgement.responseKind ===
          rightAcknowledgement.responseKind &&
        leftAcknowledgement.responseReceivedAt ===
          rightAcknowledgement.responseReceivedAt &&
        leftAcknowledgement.previousProtocolIntervalSeconds ===
          rightAcknowledgement.previousProtocolIntervalSeconds &&
        leftAcknowledgement.protocolIntervalSeconds ===
          rightAcknowledgement.protocolIntervalSeconds &&
        leftAcknowledgement.retryAfterSeconds ===
          rightAcknowledgement.retryAfterSeconds &&
        leftAcknowledgement.nextPollAt === rightAcknowledgement.nextPollAt)
  )
}

/**
 * index 只允许收敛自己的 dispatch attempt。staging 阶段仍持有
 * storage commit fence，因此还必须精确匹配进程实例。
 */
export function pollAttemptMatchesIndex(
  attempt: DevicePollAttempt,
  index: TokenIndex
): boolean {
  if (
    attempt.phase !== "dispatch_intent" ||
    attempt.ownerToken !== index.pollAttemptOwnerToken ||
    attempt.deviceGeneration !== index.deviceGeneration ||
    attempt.environment !== index.environment ||
    attempt.issuerOrigin !== index.issuerOrigin ||
    attempt.clientInstanceId !== index.clientInstanceId ||
    attempt.storageKind !== index.storageKind
  ) {
    return false
  }
  if (index.state === "stored") return true
  return (
    index.storageCommit !== null &&
    attempt.ownerPid === index.storageCommit.ownerPid &&
    attempt.ownerProcessFingerprint ===
      index.storageCommit.ownerProcessFingerprint
  )
}

export function issueReservationMatchesDevice(
  reservation: DeviceIssueReservation,
  device: DeviceAuthorizationState
): boolean {
  return (
    device.environment === reservation.environment &&
    device.issuerOrigin === reservation.issuerOrigin &&
    device.clientInstanceId === reservation.clientInstanceId &&
    device.deviceName === reservation.deviceName &&
    new Date(device.createdAt).getTime() >=
      new Date(reservation.createdAt).getTime()
  )
}
