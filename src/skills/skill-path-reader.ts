import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { isAbsolute, resolve, sep, win32 } from "node:path"
import { normalizeSkillText, sha256SkillText } from "./skill-contract.js"
import type { BigIntStats } from "node:fs"
import type { FileHandle } from "node:fs/promises"

const DEFAULT_MAXIMUM_BYTES = 1024 * 1024
const MAXIMUM_ALLOWED_BYTES = 16 * 1024 * 1024

export class SkillPathMissingError extends Error {
  constructor() {
    super("The requested Skill file does not exist.")
    this.name = "SkillPathMissingError"
  }
}

export class SkillPathUnsafeError extends Error {
  constructor() {
    super("The requested Skill path failed the local safety checks.")
    this.name = "SkillPathUnsafeError"
  }
}

export interface ReadSkillFile {
  content: string
  sha256: string
  size: number
}

interface VerifiedDirectory {
  path: string
  realpath: string
  identity: BigIntStats
}

interface ReaderOptions {
  maximumBytes?: number
  /** 以下回调仅用于可控故障注入；生产组合根不设置。 */
  onDirectoryLstat?: (depth: number) => Promise<void>
  onTargetLstat?: () => Promise<void>
  onTargetRealpath?: () => Promise<void>
  onFileOpened?: () => Promise<void>
  onOpenedFileStat?: () => Promise<void>
  onReadRequest?: (length: number) => void
}

function missingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  )
}

function safeRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 1_024 ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false
  }
  const segments = value.split("/")
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== ".."
  )
}

function contained(root: string, candidate: string): boolean {
  return candidate.startsWith(`${root}${sep}`)
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode
  )
}

async function unsafeRealpath(value: string): Promise<string> {
  try {
    return await realpath(value)
  } catch {
    throw new SkillPathUnsafeError()
  }
}

async function unsafeLstat(value: string): Promise<BigIntStats> {
  try {
    return await lstat(value, { bigint: true })
  } catch {
    throw new SkillPathUnsafeError()
  }
}

/**
 * 只读取调用方已经选定的 Skill 根。根本身允许是安装器创建的 symlink，
 * 但解析后会固定 canonical root；其下所有相对组件均逐级禁止 symlink，
 * 并在 missing、open、read 前后复核父目录与文件 identity。
 */
export class SkillPathReader {
  private readonly maximumBytes: number

  constructor(
    private readonly root: string,
    private readonly options: ReaderOptions = {}
  ) {
    const maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes <= 0 ||
      maximumBytes > MAXIMUM_ALLOWED_BYTES
    ) {
      throw new RangeError(
        `maximumBytes must be a positive safe integer no greater than ${MAXIMUM_ALLOWED_BYTES}.`
      )
    }
    this.maximumBytes = maximumBytes
  }

  private async resolveRoot(): Promise<VerifiedDirectory> {
    const rootRealpath = await unsafeRealpath(this.root)
    const identity = await unsafeLstat(rootRealpath)
    if (identity.isSymbolicLink() || !identity.isDirectory()) {
      throw new SkillPathUnsafeError()
    }
    if ((await unsafeRealpath(rootRealpath)) !== rootRealpath) {
      throw new SkillPathUnsafeError()
    }
    return { path: rootRealpath, realpath: rootRealpath, identity }
  }

  private async verifyDirectories(
    rootRealpath: string,
    directories: ReadonlyArray<VerifiedDirectory>
  ): Promise<void> {
    if ((await unsafeRealpath(this.root)) !== rootRealpath) {
      throw new SkillPathUnsafeError()
    }
    for (const [index, directory] of directories.entries()) {
      const identity = await unsafeLstat(directory.path)
      if (
        identity.isSymbolicLink() ||
        !identity.isDirectory() ||
        !sameIdentity(directory.identity, identity)
      ) {
        throw new SkillPathUnsafeError()
      }
      const resolved = await unsafeRealpath(directory.path)
      if (
        resolved !== directory.realpath ||
        (index > 0 && !contained(rootRealpath, resolved))
      ) {
        throw new SkillPathUnsafeError()
      }
    }
  }

  private async throwConfirmedMissing(
    candidate: string,
    rootRealpath: string,
    directories: ReadonlyArray<VerifiedDirectory>
  ): Promise<never> {
    await this.verifyDirectories(rootRealpath, directories)
    try {
      await lstat(candidate, { bigint: true })
      throw new SkillPathUnsafeError()
    } catch (error) {
      if (error instanceof SkillPathUnsafeError) throw error
      if (!missingFile(error)) throw new SkillPathUnsafeError()
    }
    await this.verifyDirectories(rootRealpath, directories)
    throw new SkillPathMissingError()
  }

  private async resolveParents(
    root: VerifiedDirectory,
    segments: ReadonlyArray<string>
  ): Promise<{
    directories: Array<VerifiedDirectory>
    candidate: string
  }> {
    const directories = [root]
    let parent = root.realpath
    for (const [index, segment] of segments.slice(0, -1).entries()) {
      const candidate = resolve(parent, segment)
      let identity: BigIntStats
      try {
        identity = await lstat(candidate, { bigint: true })
      } catch (error) {
        if (missingFile(error)) {
          return this.throwConfirmedMissing(
            candidate,
            root.realpath,
            directories
          )
        }
        throw new SkillPathUnsafeError()
      }
      await this.options.onDirectoryLstat?.(index + 1)
      if (identity.isSymbolicLink() || !identity.isDirectory()) {
        throw new SkillPathUnsafeError()
      }
      const resolved = await unsafeRealpath(candidate)
      if (!contained(root.realpath, resolved)) {
        throw new SkillPathUnsafeError()
      }
      await this.verifyDirectories(root.realpath, directories)
      const confirmed = await unsafeLstat(resolved)
      if (
        confirmed.isSymbolicLink() ||
        !confirmed.isDirectory() ||
        !sameIdentity(identity, confirmed)
      ) {
        throw new SkillPathUnsafeError()
      }
      directories.push({
        path: resolved,
        realpath: resolved,
        identity: confirmed,
      })
      await this.verifyDirectories(root.realpath, directories)
      parent = resolved
    }
    return {
      directories,
      candidate: resolve(parent, segments.at(-1)!),
    }
  }

  private async readBounded(handle: FileHandle): Promise<Buffer> {
    const buffer = Buffer.allocUnsafe(this.maximumBytes + 1)
    let total = 0
    while (total < buffer.byteLength) {
      const length = buffer.byteLength - total
      this.options.onReadRequest?.(length)
      let bytesRead: number
      try {
        const result = await handle.read(buffer, total, length, total)
        bytesRead = result.bytesRead
      } catch {
        throw new SkillPathUnsafeError()
      }
      if (bytesRead === 0) break
      total += bytesRead
      if (total > this.maximumBytes) throw new SkillPathUnsafeError()
    }
    return buffer.subarray(0, total)
  }

  async read(relativePath: string): Promise<ReadSkillFile> {
    if (!safeRelativePath(relativePath)) throw new SkillPathUnsafeError()
    const root = await this.resolveRoot()
    const segments = relativePath.split("/")
    const { directories, candidate } = await this.resolveParents(root, segments)
    if (!contained(root.realpath, candidate)) throw new SkillPathUnsafeError()

    let before: BigIntStats
    try {
      before = await lstat(candidate, { bigint: true })
    } catch (error) {
      if (missingFile(error)) {
        return this.throwConfirmedMissing(candidate, root.realpath, directories)
      }
      throw new SkillPathUnsafeError()
    }
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.size > BigInt(this.maximumBytes)
    ) {
      throw new SkillPathUnsafeError()
    }
    await this.verifyDirectories(root.realpath, directories)
    if (!sameIdentity(before, await unsafeLstat(candidate))) {
      throw new SkillPathUnsafeError()
    }
    await this.options.onTargetLstat?.()
    const candidateRealpath = await unsafeRealpath(candidate)
    if (!contained(root.realpath, candidateRealpath)) {
      throw new SkillPathUnsafeError()
    }
    await this.verifyDirectories(root.realpath, directories)
    if (!sameIdentity(before, await unsafeLstat(candidate))) {
      throw new SkillPathUnsafeError()
    }
    await this.options.onTargetRealpath?.()

    const flags =
      process.platform === "win32"
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW
    let handle: FileHandle
    try {
      handle = await open(candidate, flags)
    } catch {
      // final 已经 lstat 存在；此后的任何 missing 都是竞态，不再降级。
      throw new SkillPathUnsafeError()
    }

    let buffer: Buffer | null = null
    let failure: unknown = null
    try {
      await this.options.onFileOpened?.()
      const opened = await handle.stat({ bigint: true })
      if (
        !opened.isFile() ||
        opened.size > BigInt(this.maximumBytes) ||
        !sameIdentity(before, opened)
      ) {
        throw new SkillPathUnsafeError()
      }
      await this.verifyDirectories(root.realpath, directories)
      await this.options.onOpenedFileStat?.()
      buffer = await this.readBounded(handle)
      const afterRead = await handle.stat({ bigint: true })
      if (
        !afterRead.isFile() ||
        buffer.byteLength !== Number(opened.size) ||
        !sameIdentity(opened, afterRead)
      ) {
        throw new SkillPathUnsafeError()
      }
    } catch (error) {
      failure =
        error instanceof SkillPathUnsafeError
          ? error
          : new SkillPathUnsafeError()
    }
    try {
      await handle.close()
    } catch {
      failure ??= new SkillPathUnsafeError()
    }
    if (failure) throw failure
    if (!buffer) throw new SkillPathUnsafeError()

    await this.verifyDirectories(root.realpath, directories)
    const after = await unsafeLstat(candidate)
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      !sameIdentity(before, after)
    ) {
      throw new SkillPathUnsafeError()
    }
    const afterRealpath = await unsafeRealpath(candidate)
    if (
      afterRealpath !== candidateRealpath ||
      !contained(root.realpath, afterRealpath)
    ) {
      throw new SkillPathUnsafeError()
    }
    await this.verifyDirectories(root.realpath, directories)

    let decoded: string
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer)
    } catch {
      throw new SkillPathUnsafeError()
    }
    const content = normalizeSkillText(decoded)
    return {
      content,
      sha256: sha256SkillText(content),
      size: Buffer.byteLength(content, "utf8"),
    }
  }
}
