export function validateSkillAssets(
  root?: string,
  options?: {
    onReadRequest?: (relativePath: string, length: number) => void
  }
): Promise<void>
