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

export function releaseChannelForVersion(version: string): ReleaseChannel
export function validateReleaseIdentity(
  identity: ReleaseIdentity
): ValidatedReleaseIdentity
export function assertReleaseGitIdentity(
  root: string,
  identity: ReleaseIdentity
): Promise<ValidatedReleaseIdentity>
export const EXPECTED_TARBALL_FILES: ReadonlyArray<string>
