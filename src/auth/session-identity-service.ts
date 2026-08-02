import { DEADLINES_MS, EXIT_CODE } from "../constants.js"
import { createLocalSuccess } from "../contracts/envelope.js"
import { decodeMeFacts } from "../contracts/me.js"
import {
  CliFailure,
  authenticationFailure,
  dependencyFailure,
  localRequestId,
  prependFailureWarning,
} from "../errors.js"
import { outcomeFromEnvelope, warningsForEnvelope } from "../output.js"
import { credentialStorageWarning } from "../storage/credential-backend.js"
import { AuthCleanupCoordinator } from "./auth-cleanup-coordinator.js"
import { withAuthStatusUnverified } from "./auth-command-support.js"
import { authIdentitiesEqual } from "./local-credentials.js"
import type { AuthContext } from "./auth-context.js"
import type {
  LocalAuthIdentity,
  LocatedCredential,
} from "./local-credentials.js"
import type {
  PublicEnvelope,
  PublicErrorEnvelope,
  PublicSuccessEnvelope,
} from "../contracts/envelope.js"
import type { MeFacts } from "../contracts/me.js"
import type { CliOutcome } from "../errors.js"
import type { GlobalOptions } from "../parser.js"
import type { CredentialMetadata } from "../storage/schemas.js"
import type { JsonObject } from "../contracts/json.js"

const IDENTITY_ERROR_REASONS = Object.freeze({
  INVALID_CREDENTIAL: "invalid_credential",
  CREDENTIAL_EXPIRED: "credential_expired",
  USER_DISABLED: "user_disabled",
  OWNER_REQUIRED: "owner_required",
} as const)

type IdentityErrorCode = keyof typeof IDENTITY_ERROR_REASONS

export interface MeSuccess {
  envelope: PublicSuccessEnvelope
  facts: MeFacts
  metadata: CredentialMetadata
}

/** 只负责本地凭证定位后的 /me 验证、身份诊断和 metadata 落盘。 */
export class SessionIdentityService {
  private readonly cleanup: AuthCleanupCoordinator

  constructor(private readonly context: AuthContext) {
    this.cleanup = new AuthCleanupCoordinator(context.local, context.now)
  }

  async status(global: GlobalOptions): Promise<CliOutcome> {
    let inspection
    try {
      inspection = await this.context.local.inspectAndRecover()
    } catch (error) {
      if (error instanceof CliFailure && error.exitCode === 5) {
        return this.localStatusOutcome("local_incomplete", "token_missing")
      }
      if (
        error instanceof CliFailure &&
        !error.envelope.ok &&
        error.envelope.error.details.reason === "metadata_mismatch"
      ) {
        return this.localStatusOutcome("local_incomplete", "metadata_mismatch")
      }
      if (error instanceof CliFailure && !error.envelope.ok) {
        return {
          exitCode: EXIT_CODE.retryable,
          envelope: withAuthStatusUnverified(error.envelope),
          warnings: error.warnings,
        }
      }
      throw error
    }
    if (inspection.state === "none") {
      return this.localStatusOutcome("not_authenticated", "token_missing")
    }
    if (inspection.state === "device_only") {
      return this.localStatusOutcome("local_incomplete", "token_missing")
    }
    if (inspection.state === "local_incomplete") {
      return this.localStatusOutcome(
        "local_incomplete",
        inspection.reason as
          | "token_missing"
          | "token_index_missing"
          | "metadata_mismatch"
      )
    }
    try {
      const me = await this.callMe(inspection, global, false)
      if ("error" in me) {
        if (this.isIdentityError(me.error)) {
          return this.withStorageWarning(
            this.remoteInvalidStatus(
              inspection,
              IDENTITY_ERROR_REASONS[me.error.error.code as IdentityErrorCode],
              me.error
            ),
            inspection
          )
        }
        return this.withStorageWarning(
          outcomeFromEnvelope(
            withAuthStatusUnverified(me.error),
            this.context.environment
          ),
          inspection
        )
      }
      return this.withStorageWarning(
        {
          exitCode: EXIT_CODE.success,
          envelope: createLocalSuccess(
            me.envelope.meta.requestId,
            this.statusData({
              status: "active",
              authenticated: true,
              located: inspection,
              metadata: me.metadata,
              facts: me.facts,
              reason: null,
            }),
            me.envelope.meta
          ),
          warnings: warningsForEnvelope(me.envelope, this.context.environment),
        },
        inspection
      )
    } catch (error) {
      if (error instanceof CliFailure && error.envelope.ok === false) {
        if (
          error.exitCode === EXIT_CODE.authentication &&
          error.envelope.error.details.reason === "metadata_mismatch"
        ) {
          return this.withStorageWarning(
            this.localStatusOutcome("local_incomplete", "metadata_mismatch"),
            inspection
          )
        }
        return this.withStorageWarning(
          {
            exitCode: EXIT_CODE.retryable,
            envelope: withAuthStatusUnverified(error.envelope),
            warnings: error.warnings,
          },
          inspection
        )
      }
      throw error
    }
  }

  async whoami(global: GlobalOptions): Promise<CliOutcome> {
    const located = await this.context.local.requireLocated()
    try {
      const result = await this.callMe(located, global, true)
      return this.withStorageWarning(
        "error" in result
          ? outcomeFromEnvelope(result.error, this.context.environment)
          : outcomeFromEnvelope(result.envelope, this.context.environment),
        located
      )
    } catch (error) {
      throw prependFailureWarning(
        error,
        credentialStorageWarning(located.index.storageKind)
      )
    }
  }

  async callMe(
    located: LocatedCredential,
    global: GlobalOptions,
    clearOnTerminal: boolean
  ): Promise<MeSuccess | { error: PublicErrorEnvelope }> {
    await this.assertExpectedIdentity(located.identity)
    let envelope: PublicEnvelope
    try {
      const response = await this.context.http.requestPublic({
        method: "GET",
        issuerOrigin: located.index.issuerOrigin,
        path: "/public/v1/me",
        token: located.token,
        requestId: global.requestId,
        deadlineMs: DEADLINES_MS.standard,
      })
      envelope = response.envelope
    } catch (error) {
      if (error instanceof CliFailure) throw error
      throw dependencyFailure(
        "The current credential could not be verified.",
        EXIT_CODE.retryable,
        { authStatus: "unverified" }
      )
    }
    if (!envelope.ok) {
      if (clearOnTerminal && this.isIdentityError(envelope)) {
        await this.cleanup.clearIfUnchanged(located.identity)
      }
      return { error: envelope }
    }
    const decoded = decodeMeFacts(envelope, located.index.credentialId)
    if (decoded.kind === "contract_invalid") {
      throw dependencyFailure(
        "The server returned an invalid /me success contract. The local credential was preserved.",
        EXIT_CODE.retryable,
        {
          authStatus: "unverified",
          responseKind: "me_contract_invalid",
        }
      )
    }
    if (decoded.kind === "identity_mismatch") {
      const cleared = clearOnTerminal
        ? await this.cleanup.clearIfUnchanged(located.identity)
        : "stale"
      throw authenticationFailure(
        clearOnTerminal && cleared === "cleared"
          ? "The /me credential identity did not match the locally stored Token. The old local credential was removed; revoke the device on the official Web page."
          : "The /me credential identity did not match the locally stored Token. No current local credential was removed.",
        "INVALID_CREDENTIAL",
        {
          reason: "metadata_mismatch",
          localCredentialRemoved: clearOnTerminal && cleared === "cleared",
        }
      )
    }
    const facts = decoded.facts
    const metadata = await this.context.local.persistMeFacts(located, facts)
    return { envelope, facts, metadata }
  }

  async assertExpectedIdentity(expected: LocalAuthIdentity): Promise<void> {
    const current = await this.context.local.captureIdentity()
    if (!authIdentitiesEqual(current, expected)) {
      throw dependencyFailure(
        "Local authentication state changed before the remote request; no request was sent.",
        EXIT_CODE.retryable,
        { localStateChanged: true }
      )
    }
  }

  private isIdentityError(
    envelope: PublicErrorEnvelope
  ): envelope is PublicErrorEnvelope {
    return envelope.error.code in IDENTITY_ERROR_REASONS
  }

  private localStatusOutcome(
    status: "not_authenticated" | "local_incomplete",
    reason: "token_missing" | "token_index_missing" | "metadata_mismatch"
  ): CliOutcome {
    return {
      exitCode: EXIT_CODE.success,
      envelope: createLocalSuccess(localRequestId(), {
        status,
        authenticated: false,
        issuerOrigin: null,
        credentialKind: null,
        credentialId: null,
        team: null,
        credential: null,
        reason,
      }),
      warnings: [],
    }
  }

  private remoteInvalidStatus(
    located: LocatedCredential,
    reason:
      | "invalid_credential"
      | "credential_expired"
      | "user_disabled"
      | "owner_required",
    envelope: PublicErrorEnvelope
  ): CliOutcome {
    return {
      exitCode: EXIT_CODE.success,
      envelope: createLocalSuccess(
        envelope.meta.requestId,
        this.statusData({
          status: "remote_invalid",
          authenticated: false,
          located,
          metadata: located.credentials,
          facts: null,
          reason,
        }),
        envelope.meta
      ),
      warnings: warningsForEnvelope(envelope, this.context.environment),
    }
  }

  private statusData(input: {
    status: "active" | "remote_invalid"
    authenticated: boolean
    located: LocatedCredential
    metadata: CredentialMetadata | null
    facts: MeSuccess["facts"] | null
    reason:
      | "invalid_credential"
      | "credential_expired"
      | "user_disabled"
      | "owner_required"
      | null
  }): JsonObject {
    return {
      status: input.status,
      authenticated: input.authenticated,
      issuerOrigin: input.located.index.issuerOrigin,
      credentialKind: "owner_cli_session",
      credentialId: input.located.index.credentialId,
      team:
        input.facts && input.metadata
          ? {
              teamId: input.facts.teamId,
              teamName: input.facts.teamName,
            }
          : input.metadata
            ? {
                teamId: input.metadata.teamId,
                teamName: input.metadata.teamName,
              }
            : null,
      credential: input.facts
        ? {
            activationExpiresAt: input.facts.activationExpiresAt,
            idleExpiresAt: input.facts.idleExpiresAt,
            absoluteExpiresAt: input.facts.absoluteExpiresAt,
          }
        : null,
      reason: input.reason,
    }
  }

  private withStorageWarning(
    outcome: CliOutcome,
    located: Pick<LocatedCredential, "index">
  ): CliOutcome {
    const warning = credentialStorageWarning(located.index.storageKind)
    if (warning === null || outcome.warnings.includes(warning)) return outcome
    return { ...outcome, warnings: [warning, ...outcome.warnings] }
  }
}
