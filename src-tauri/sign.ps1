# Authenticode signs (and timestamps) Windows binaries. One script for every
# caller: tauri's bundle.windows.signCommand (the app exe, sidecars, the NSIS
# installer and its uninstaller), sign-engine.sh, and the release workflow's
# pre-pack and verify steps. See docs/code-signing.md.
#
#   sign.ps1 <file>                sign one file
#   sign.ps1 -Dir <dir> [<dir>..]  sign every .exe/.dll under the folders
#   sign.ps1 -Verify <paths..>     fail unless every .exe/.dll is validly signed
#
# FLINT_SIGN_MODE picks the credential:
#   trusted  Azure Trusted Signing through signtool's dlib. Needs
#            TRUSTED_SIGNING_DLIB, TRUSTED_SIGNING_METADATA (the dlib's JSON) and
#            AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET.
#   pfx      A code signing certificate. Needs WINDOWS_CERTIFICATE_PATH and
#            WINDOWS_CERTIFICATE_PASSWORD.
#   unset    Signing is not configured: print why and exit 0, so unsigned
#            local and CI builds keep working.
#
# Files that already carry a valid signature (bun and uv as their vendors ship
# them, a file signed earlier in the same build) are left alone.
param(
  [switch]$Verify,
  [switch]$Dir,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Paths
)

$ErrorActionPreference = 'Stop'
$mode = "$env:FLINT_SIGN_MODE".ToLowerInvariant()

function Find-SignTool {
  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $kits = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
  $found = Get-ChildItem -Path $kits -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.DirectoryName -like '*\x64' } |
    Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $found) { throw 'signtool.exe not found (install the Windows SDK).' }
  return $found.FullName
}

function Get-PeFiles([string[]]$roots) {
  foreach ($r in $roots) {
    if (Test-Path -LiteralPath $r -PathType Container) {
      Get-ChildItem -LiteralPath $r -Recurse -File -Include *.exe, *.dll | ForEach-Object { $_.FullName }
    } elseif (Test-Path -LiteralPath $r -PathType Leaf) {
      (Resolve-Path -LiteralPath $r).Path
    } else {
      Write-Host "skip: $r does not exist"
    }
  }
}

function Test-Signed([string]$file) {
  (Get-AuthenticodeSignature -LiteralPath $file).Status -eq 'Valid'
}

if (-not $Paths -or $Paths.Count -eq 0) { throw 'usage: sign.ps1 [-Dir|-Verify] <path>...' }

if ($Verify) {
  $files = @(Get-PeFiles $Paths)
  if ($mode -ne 'trusted' -and $mode -ne 'pfx') {
    Write-Host "::notice::Windows code signing is not configured; not verifying $($files.Count) unsigned binaries."
    exit 0
  }
  $signtool = Find-SignTool
  $bad = @()
  foreach ($f in $files) {
    & $signtool verify /pa /q $f | Out-Null
    if ($LASTEXITCODE -ne 0) { $bad += $f; Write-Host "::error::not signed: $f" }
    else { Write-Host "verified: $f" }
  }
  if ($bad.Count -gt 0) { throw "$($bad.Count) of $($files.Count) binaries are not validly signed." }
  Write-Host "All $($files.Count) binaries carry a valid, timestamped signature."
  exit 0
}

if ($mode -ne 'trusted' -and $mode -ne 'pfx') {
  Write-Host "Windows code signing is not configured (FLINT_SIGN_MODE unset); leaving $($Paths -join ', ') unsigned."
  exit 0
}

$signtool = Find-SignTool
if ($mode -eq 'trusted') {
  foreach ($v in 'TRUSTED_SIGNING_DLIB', 'TRUSTED_SIGNING_METADATA', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET') {
    if (-not (Get-Item "env:$v" -ErrorAction SilentlyContinue).Value) { throw "$v is unset (FLINT_SIGN_MODE=trusted)." }
  }
  $signArgs = @('sign', '/v', '/fd', 'SHA256', '/tr', 'http://timestamp.acs.microsoft.com', '/td', 'SHA256',
    '/dlib', $env:TRUSTED_SIGNING_DLIB, '/dmdf', $env:TRUSTED_SIGNING_METADATA)
} else {
  foreach ($v in 'WINDOWS_CERTIFICATE_PATH', 'WINDOWS_CERTIFICATE_PASSWORD') {
    if (-not (Get-Item "env:$v" -ErrorAction SilentlyContinue).Value) { throw "$v is unset (FLINT_SIGN_MODE=pfx)." }
  }
  $signArgs = @('sign', '/v', '/fd', 'SHA256', '/tr', 'http://timestamp.digicert.com', '/td', 'SHA256',
    '/f', $env:WINDOWS_CERTIFICATE_PATH, '/p', $env:WINDOWS_CERTIFICATE_PASSWORD)
}

$files = if ($Dir) { @(Get-PeFiles $Paths) } else { @($Paths) }
$signed = 0
foreach ($f in $files) {
  if (Test-Signed $f) { Write-Host "already signed, leaving as is: $f"; continue }
  # The timestamp servers rate limit now and then; try a few times.
  $ok = $false
  for ($i = 1; $i -le 3 -and -not $ok; $i++) {
    & $signtool @signArgs $f
    if ($LASTEXITCODE -eq 0) { $ok = $true } else { Start-Sleep -Seconds (5 * $i) }
  }
  if (-not $ok) { throw "signtool failed to sign $f" }
  $signed++
}
Write-Host "Signed $signed of $($files.Count) binaries ($mode)."
