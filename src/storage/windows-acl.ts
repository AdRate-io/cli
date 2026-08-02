import { Buffer } from "node:buffer"
import { win32 } from "node:path"
import { NativeProcessError } from "./native-process.js"
import type { WindowsAclController } from "./secure-files.js"
import type {
  NativeProcessResult,
  NativeProcessRunner,
} from "./native-process.js"

const ACL_SCRIPT = `
$ErrorActionPreference = "Stop"
try {
  $encodedInput = @($input) -join ""
  if ([string]::IsNullOrWhiteSpace($encodedInput) -or
      $encodedInput.Length -gt 262144) { exit 23 }
  $json = [System.Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($encodedInput)
  )
  $request = ConvertFrom-Json -InputObject $json
} catch {
  exit 23
}
$propertyNames = @($request.PSObject.Properties.Name)
if ($propertyNames.Count -ne 4 -or
    -not ($propertyNames -contains "action") -or
    -not ($propertyNames -contains "literalPath") -or
    -not ($propertyNames -contains "kind") -or
    -not ($propertyNames -contains "targetPath")) { exit 23 }
$Action = $request.action
$LiteralPath = $request.literalPath
$Kind = $request.kind
$TargetPath = $request.targetPath
if ($Action -isnot [string] -or $LiteralPath -isnot [string] -or
    $Kind -isnot [string] -or $TargetPath -isnot [string] -or
    [string]::IsNullOrEmpty($LiteralPath)) { exit 23 }
if ($Action -notin @("ensure_directory", "secure", "verify", "replace")) {
  exit 15
}
if ($Kind -notin @("file", "directory")) { exit 15 }
if ($Action -eq "ensure_directory" -and
    ($Kind -ne "directory" -or $TargetPath.Length -ne 0)) { exit 15 }
if (($Action -eq "secure" -or $Action -eq "verify") -and
    $TargetPath.Length -ne 0) { exit 15 }
if ($Action -eq "replace" -and
    ($Kind -ne "file" -or [string]::IsNullOrEmpty($TargetPath))) { exit 15 }
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
function New-AdRateAcl([string]$Kind) {
  if ($Kind -eq "directory") {
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $inherit = [System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit"
  } else {
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $inherit = [System.Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($sid)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $sid,
    $fullControl,
    $inherit,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
  return $acl
}
if ($Action -eq "ensure_directory") {
  if (-not (Test-Path -LiteralPath $LiteralPath)) {
    $acl = New-AdRateAcl "directory"
    [void][System.IO.Directory]::CreateDirectory($LiteralPath, $acl)
  }
  "OK"
  exit 0
}
if ($Action -eq "secure") {
  $acl = New-AdRateAcl $Kind
  Set-Acl -LiteralPath $LiteralPath -AclObject $acl
  "OK"
  exit 0
}
if ($Action -eq "verify") {
  $item = Get-Item -LiteralPath $LiteralPath -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 12 }
  if ($Kind -eq "directory" -and -not $item.PSIsContainer) { exit 16 }
  if ($Kind -eq "file" -and $item.PSIsContainer) { exit 17 }
  $acl = Get-Acl -LiteralPath $LiteralPath
  if ($acl.Owner -ne $identity.Name -and $acl.Owner -ne $sid.Value) { exit 13 }
  if (-not $acl.AreAccessRulesProtected) { exit 18 }
  $rules = @($acl.Access)
  if ($rules.Count -ne 1) { exit 19 }
  $rule = $rules[0]
  $ruleSid = $rule.IdentityReference.Translate(
    [System.Security.Principal.SecurityIdentifier]
  )
  if ($ruleSid.Value -ne $sid.Value) { exit 14 }
  if ($rule.IsInherited) { exit 20 }
  if ($rule.AccessControlType -ne
      [System.Security.AccessControl.AccessControlType]::Allow) { exit 21 }
  if (($rule.FileSystemRights -band $fullControl) -ne $fullControl) { exit 22 }
  "OK"
  exit 0
}
if ($Action -eq "replace") {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AdRateMoveFile {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool MoveFileEx(string existingName, string newName, int flags);
}
"@
  $MOVEFILE_REPLACE_EXISTING = 0x1
  $MOVEFILE_WRITE_THROUGH = 0x8
  if (-not [AdRateMoveFile]::MoveFileEx(
    $LiteralPath,
    $TargetPath,
    $MOVEFILE_REPLACE_EXISTING -bor $MOVEFILE_WRITE_THROUGH
  )) {
    throw "MoveFileExW failed"
  }
  "OK"
  exit 0
}
exit 15
`

function encodedScript(): string {
  return Buffer.from(ACL_SCRIPT, "utf16le").toString("base64")
}

interface WindowsAclRequest {
  action: "ensure_directory" | "secure" | "verify" | "replace"
  literalPath: string
  kind: "file" | "directory"
  targetPath: string
}

function encodedRequest(request: WindowsAclRequest): string {
  return Buffer.from(JSON.stringify(request), "utf8").toString("base64")
}

export class PowerShellWindowsAclController implements WindowsAclController {
  constructor(
    private readonly runner: NativeProcessRunner,
    private readonly powerShellPath: string
  ) {
    if (!win32.isAbsolute(powerShellPath)) {
      throw new NativeProcessError(
        "The Windows ACL helper path must be absolute."
      )
    }
  }

  async ensureDirectory(path: string): Promise<void> {
    await this.requireSuccess(
      await this.run({
        action: "ensure_directory",
        literalPath: path,
        kind: "directory",
        targetPath: "",
      }),
      "Windows protected directory creation failed."
    )
  }

  async secure(path: string, kind: "file" | "directory"): Promise<void> {
    await this.requireSuccess(
      await this.run({
        action: "secure",
        literalPath: path,
        kind,
        targetPath: "",
      }),
      "Windows ACL hardening failed."
    )
  }

  async verify(path: string, kind: "file" | "directory"): Promise<boolean> {
    const result = await this.run({
      action: "verify",
      literalPath: path,
      kind,
      targetPath: "",
    })
    return result.code === 0 && result.stdout.trim() === "OK"
  }

  async atomicReplace(source: string, target: string): Promise<void> {
    await this.requireSuccess(
      await this.run({
        action: "replace",
        literalPath: source,
        kind: "file",
        targetPath: target,
      }),
      "Windows atomic credential replacement failed."
    )
  }

  private run(request: WindowsAclRequest): Promise<NativeProcessResult> {
    // Windows PowerShell 5.1 的 -EncodedCommand 只承载命令本身。操作数据
    // 经 -InputFormat Text 和 $input 单独传入，避免把路径当作裸 trailing
    // argument 而依赖未证明的 param 绑定或 shell quoting。
    return this.runner.run(
      this.powerShellPath,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-InputFormat",
        "Text",
        "-EncodedCommand",
        encodedScript(),
      ],
      encodedRequest(request)
    )
  }

  private requireSuccess(result: NativeProcessResult, message: string): void {
    if (result.code !== 0 || result.stdout.trim() !== "OK") {
      throw new NativeProcessError(message)
    }
  }
}

export function trustedWindowsPowerShellPath(
  environment: NodeJS.ProcessEnv = process.env
): string {
  const systemRoot = environment.SystemRoot
  const trustedRoot =
    typeof systemRoot === "string" && /^[A-Za-z]:\\Windows$/iu.test(systemRoot)
      ? systemRoot
      : "C:\\Windows"
  return win32.join(
    trustedRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  )
}
