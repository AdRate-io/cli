export interface MirrorFile {
  path: string
  sha256: string
  content: Buffer
}

export interface MirrorSummary {
  added: Array<string>
  updated: Array<string>
  removed: Array<string>
  unchanged: Array<string>
}

export interface MirrorPlan {
  sourceRoot: string
  targetRoot: string
  sourceCommit: string
  targetCommit: string
  targetFiles: Map<string, string>
  files: Array<MirrorFile>
  summary: MirrorSummary
}

export interface MirrorPlanOptions {
  sourceRoot: string
  targetRoot: string
  sourceCommit: string
  targetCommit: string
  /** 仅供竞态回归夹具使用；正式 CLI 入口不可传入。 */
  testHooks?: {
    afterSourceCheckoutValidated?: () => void | Promise<void>
  }
}

export interface MirrorApplyOptions {
  /** 仅供竞态回归夹具使用；正式 CLI 入口不可传入。 */
  testHooks?: {
    beforeTargetPatchApply?: () => void | Promise<void>
  }
}

export function isAllowedMirrorPath(path: string): boolean
export function collectMirrorSource(
  sourceRoot: string
): Promise<Array<MirrorFile>>
export function collectReleaseSource(
  sourceRoot: string,
  options?: { requireCommitted: boolean }
): Promise<Array<MirrorFile>>
export function createMirrorPlan(
  options: MirrorPlanOptions
): Promise<MirrorPlan>
export function applyMirrorPlan(
  plan: MirrorPlan,
  options?: MirrorApplyOptions
): Promise<void>
