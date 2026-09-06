#Requires -Version 5.1
<#
.SYNOPSIS
Installs the `jan` agent CLI on Windows by compiling it from this checkout.

.DESCRIPTION
The PowerShell counterpart of install-jan-agent.sh. There is no download path:
this build is local-only, so nothing is fetched from a release host and the
binary has no self-updater.

.EXAMPLE
.\scripts\install-jan-agent.ps1
.EXAMPLE
.\scripts\install-jan-agent.ps1 -AddToPath
#>
[CmdletBinding()]
param(
  # Install directory. Defaults to $env:JAN_INSTALL_DIR, else a per-user
  # location that needs no elevation.
  [string]$Dir,
  # Append the install directory to the user PATH (persisted, not just this session).
  [switch]$AddToPath
)

$ErrorActionPreference = 'Stop'

$BinaryName = 'jan.exe'

if (-not $Dir) {
  if ($env:JAN_INSTALL_DIR) {
    $Dir = $env:JAN_INSTALL_DIR
  } else {
    $Dir = Join-Path $env:LOCALAPPDATA 'Programs\Jan'
  }
}

function Install-Binary {
  param([Parameter(Mandatory)][string]$Source)

  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $dest = Join-Path $Dir $BinaryName

  # A running executable cannot be overwritten, but it can be renamed; the
  # stale copy is removed on the next install.
  $backup = "$dest.old"
  if (Test-Path -LiteralPath $backup) {
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $dest) {
    try {
      Remove-Item -LiteralPath $dest -Force
    } catch {
      Move-Item -LiteralPath $dest -Destination $backup -Force
      Write-Warning "$BinaryName was in use; the previous copy is at $backup"
    }
  }
  Copy-Item -LiteralPath $Source -Destination $dest -Force

  Write-Host "installed $dest"

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $onPath = ($env:Path -split ';') -contains $Dir
  if ($AddToPath) {
    if (($userPath -split ';') -notcontains $Dir) {
      $updated = if ([string]::IsNullOrEmpty($userPath)) { $Dir } else { "$userPath;$Dir" }
      [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
      Write-Host "added $Dir to your user PATH; open a new terminal to pick it up"
    } else {
      Write-Host "$Dir is already on your user PATH"
    }
  } elseif (-not $onPath) {
    Write-Host "note: $Dir is not on your PATH; re-run with -AddToPath or add it yourself"
  }
}

function Install-FromSource {
  if (-not $PSCommandPath) {
    throw 'run this script from a checkout: it builds the CLI from source'
  }
  $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
  if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw 'cargo not found; install Rust first'
  }
  Write-Host "building the CLI from $RepoRoot (release)"
  Push-Location (Join-Path $RepoRoot 'src-tauri')
  try {
    # The CLI and the desktop app are mutually exclusive feature configs, so
    # the default features must stay off.
    cargo build --no-default-features --features cli --bin jan --release
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
  $built = Join-Path $RepoRoot "src-tauri\target\release\$BinaryName"
  if (-not (Test-Path -LiteralPath $built)) { throw "expected a binary at $built" }
  Install-Binary -Source $built
}

Install-FromSource
