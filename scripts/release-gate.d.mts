export type ReleaseChannel = "prerelease" | "stable"

export interface ReleaseIdentity {
  version: string
  tag: string
  commit: string
  channel: ReleaseChannel
}

export interface ValidatedReleaseIdentity extends ReleaseIdentity {
  distTag: "next" | "latest"
}

export const EXTERNAL_GATE_IDS: ReadonlyArray<string>
export const PRERELEASE_GATE_IDS: ReadonlyArray<string>
export const STABLE_GATE_IDS: ReadonlyArray<string>

export function assertReproducibleTarballBytes(
  firstTarball: Uint8Array,
  secondTarball: Uint8Array
): string
export function releaseChannelForVersion(version: string): ReleaseChannel
export function validateReleaseIdentity(
  identity: ReleaseIdentity
): ValidatedReleaseIdentity
export function assertReleaseGitIdentity(
  root: string,
  identity: ReleaseIdentity
): Promise<ValidatedReleaseIdentity>
export function validatePublishWorkflow(workflow: string): void
export function validateReleaseTrainEvidenceBinding(options: {
  channel: ReleaseChannel
  currentVersion: string
  currentCommit: string
  currentArtifactSha256: string
  evidence: {
    releaseTrain: string
    validatedCommit: string
    testedVersion: string
    testedCommit: string
    tarballSha256: string
  }
  validatedCommitIsAncestor: boolean
  testedCommitIsAncestor: boolean
  runtimeCompatible: boolean
}): void
export function assertStableRuntimeCompatibility(
  root: string,
  testedCommit: string,
  currentCommit: string
): Promise<void>
export function assertPrereleaseRuntimeCompatibility(
  root: string,
  testedCommit: string,
  currentCommit: string
): Promise<void>
export function validateTrustedEvidencePinsDocument(
  document: unknown
): Record<
  string,
  { sha256: string; issuer: string; environment: string } | null
>
export function verifyTrustedEvidencePins(
  root: string
): Promise<
  Record<string, { sha256: string; issuer: string; environment: string } | null>
>
export function validateExternalReadinessDocument(
  readiness: unknown
): Record<string, unknown>
export function verifyExternalReadinessEvidence(options: {
  root: string
  readiness: unknown
  channel: ReleaseChannel
  version: string
  commit: string
  currentArtifactSha256?: string
}): Promise<void>
export function verifyReleaseArtifact(
  artifactDirectory: string,
  identity: ReleaseIdentity
): Promise<{
  tarball: string
  sha256: string
  identity: ValidatedReleaseIdentity
}>
export function assertRegistryMonotonicResponse(
  candidateVersion: string,
  channel: ReleaseChannel,
  response: { status: number; text: string }
): void
