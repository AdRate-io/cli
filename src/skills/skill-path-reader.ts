import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { isAbsolute, resolve, sep, win32 } from "node:path"
import { normalizeSkillText, sha256SkillText } from "./skill-contract.js"
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

interface ReaderOptions {
  maximumBytes?: number
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
  return value
    .split("/")
    .every(
      (segment) => segment.length > 0 && segment !== "." && segment !== ".."
    )
}

function contained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

async function canonicalDirectory(path: string): Promise<string> {
  let resolved: string
  try {
    resolved = await realpath(path)
    const info = await lstat(resolved)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new SkillPathUnsafeError()
    }
  } catch (error) {
    if (error instanceof SkillPathUnsafeError) throw error
    if (missingFile(error)) throw new SkillPathMissingError()
    throw new SkillPathUnsafeError()
  }
  return resolved
}

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

  private async candidate(relativePath: string): Promise<string> {
    const root = await canonicalDirectory(this.root)
    const segments = relativePath.split("/")
    let parent = root
    for (const segment of segments.slice(0, -1)) {
      const path = resolve(parent, segment)
      let info
      try {
        info = await lstat(path)
      } catch (error) {
        if (missingFile(error)) throw new SkillPathMissingError()
        throw new SkillPathUnsafeError()
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new SkillPathUnsafeError()
      }
      parent = await canonicalDirectory(path)
      if (!contained(root, parent)) throw new SkillPathUnsafeError()
    }

    const candidate = resolve(parent, segments.at(-1)!)
    if (!contained(root, candidate)) throw new SkillPathUnsafeError()
    let info
    try {
      info = await lstat(candidate)
    } catch (error) {
      if (missingFile(error)) throw new SkillPathMissingError()
      throw new SkillPathUnsafeError()
    }
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      info.size > this.maximumBytes
    ) {
      throw new SkillPathUnsafeError()
    }
    let resolvedCandidate: string
    try {
      resolvedCandidate = await realpath(candidate)
    } catch {
      throw new SkillPathUnsafeError()
    }
    if (!contained(root, resolvedCandidate)) throw new SkillPathUnsafeError()
    return resolvedCandidate
  }

  private async readBounded(handle: FileHandle): Promise<Buffer> {
    const buffer = Buffer.allocUnsafe(this.maximumBytes + 1)
    let total = 0
    while (total < buffer.byteLength) {
      const length = buffer.byteLength - total
      this.options.onReadRequest?.(length)
      const result = await handle.read(buffer, total, length, total)
      if (result.bytesRead === 0) break
      total += result.bytesRead
      if (total > this.maximumBytes) throw new SkillPathUnsafeError()
    }
    return buffer.subarray(0, total)
  }

  async read(relativePath: string): Promise<ReadSkillFile> {
    if (!safeRelativePath(relativePath)) throw new SkillPathUnsafeError()
    const candidate = await this.candidate(relativePath)
    const flags =
      process.platform === "win32"
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW
    let handle: FileHandle
    try {
      handle = await open(candidate, flags)
    } catch {
      throw new SkillPathUnsafeError()
    }

    let buffer: Buffer | null = null
    let failure: unknown = null
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > this.maximumBytes) {
        throw new SkillPathUnsafeError()
      }
      buffer = await this.readBounded(handle)
      if (buffer.byteLength !== info.size) throw new SkillPathUnsafeError()
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
