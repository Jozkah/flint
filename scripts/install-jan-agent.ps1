#Requires -Version 5.1
<#
.SYNOPSIS
Installs the `jan` agent CLI on Windows: either a published build from
Flint's GitHub releases (default) or one compiled from this checkout (-Source).

.DESCRIPTION
The PowerShell counterpart of install-jan-agent.sh. The CLI has no
self-update command: re-run this script to update.

.EXAMPLE
.\scripts\install-jan-agent.ps1
.EXAMPLE
.\scripts\install-jan-agent.ps1 -Version 1.0.0 -AddToPath
.EXAMPLE
.\scripts\install-jan-agent.ps1 -Source
#>
[CmdletBinding()]
param(
  # Install directory. Defaults to $env:JAN_INSTALL_DIR, else a per-user
  # location that needs no elevation.
  [string]$Dir,
  [string]$Version = '',
  [switch]$Source,
  # Append the install directory to the user PATH (persisted, not just this session).
  [switch]$AddToPath
)

$ErrorActionPreference = 'Stop'
# Speeds up Invoke-WebRequest on PowerShell 5.1 by orders of magnitude.
$ProgressPreference = 'SilentlyContinue'

$BinaryName = 'flint.exe'
$Target = 'x86_64-pc-windows-msvc'
$Repo = 'Jozkah/flint'

if (-not $Dir) {
  if ($env:JAN_INSTALL_DIR) {
    $Dir = $env:JAN_INSTALL_DIR
  } else {
    $Dir = Join-Path $env:LOCALAPPDATA 'Programs\Jan'
  }
}

if ([Environment]::Is64BitOperatingSystem -eq $false) {
  throw 'no published build for 32-bit Windows; use -Source'
}
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
  Write-Warning 'no native ARM64 build is published; the x86_64 build runs under emulation'
}

# PowerShell 5.1 defaults to TLS 1.0, which GitHub rejects.
if ([Net.ServicePointManager]::SecurityProtocol -notmatch 'Tls12') {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

function Install-Binary {
  param([Parameter(Mandatory)][string]$Source, [string]$Label)

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

  if ($Label) {
    Write-Host "installed $dest ($Label)"
  } else {
    Write-Host "installed $dest"
  }

  # Read the user PATH as stored: GetEnvironmentVariable expands %VAR% entries,
  # and writing that back would flatten them and turn REG_EXPAND_SZ into REG_SZ.
  $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  $userPath = ''
  if ($envKey) {
    $userPath = [string]$envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $envKey.Close()
  }
  $onPath = ($env:Path -split ';') -contains $Dir
  if ($AddToPath) {
    if (($userPath -split ';') -notcontains $Dir) {
      $updated = if ([string]::IsNullOrEmpty($userPath)) { $Dir } else { "$userPath;$Dir" }
      $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
      $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
      try { $kind = $envKey.GetValueKind('Path') } catch { }
      $envKey.SetValue('Path', $updated, $kind)
      $envKey.Close()
      # Setting and clearing a variable broadcasts the environment change.
      [Environment]::SetEnvironmentVariable('FLINT_ENV_REFRESH', '1', 'User')
      [Environment]::SetEnvironmentVariable('FLINT_ENV_REFRESH', $null, 'User')
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
    throw '-Source requires running the script from a checkout; download scripts\install-jan-agent.ps1 and run it from the repo'
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
    cargo build --no-default-features --features cli --bin flint --release
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
  $built = Join-Path $RepoRoot "src-tauri\target\release\$BinaryName"
  if (-not (Test-Path -LiteralPath $built)) { throw "expected a binary at $built" }
  Install-Binary -Source $built
  Write-Host 'note: to update a source build, pull and re-run this script with -Source'
}

function Install-Published {
  if ($Version) {
    $tag = 'v' + $Version.TrimStart('v')
  } else {
    Write-Host "resolving the latest release of $Repo"
    try {
      $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing
    } catch {
      throw "cannot resolve the latest release of $Repo : $($_.Exception.Message)"
    }
    $tag = [string]$release.tag_name
    if (-not $tag) { throw "cannot resolve the latest release of $Repo" }
  }
  $resolved = $tag.TrimStart('v')
  $base = "https://github.com/$Repo/releases/download/$tag"
  $asset = "flint-$resolved-$Target.zip"
  $url = "$base/$asset"

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("flint-cli-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    # Every release publishes sha256sums.txt; an archive without a matching
    # line is refused rather than installed unverified.
    $sumsPath = Join-Path $tmp 'sha256sums.txt'
    try {
      Invoke-WebRequest -Uri "$base/sha256sums.txt" -OutFile $sumsPath -UseBasicParsing
    } catch {
      throw "cannot fetch $base/sha256sums.txt : $($_.Exception.Message)"
    }
    $expected = ''
    foreach ($line in Get-Content -LiteralPath $sumsPath) {
      if ($line -match '^([0-9a-fA-F]{64})\s+\*?(\S+)$' -and $Matches[2] -eq $asset) {
        $expected = $Matches[1]
        break
      }
    }
    if (-not $expected) { throw "release $tag has no checksum for $asset" }

    $archive = Join-Path $tmp $asset
    Write-Host "downloading $tag from $url"
    try {
      Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing
    } catch {
      throw "download failed: $url : $($_.Exception.Message)"
    }

    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    if ($actual -ne $expected.ToUpperInvariant()) {
      throw "checksum mismatch: expected $expected, got $actual"
    }
    Write-Host 'sha256 verified'

    Expand-Archive -LiteralPath $archive -DestinationPath $tmp -Force
    # Published zips keep flint.exe at the root; search anyway so a packaging
    # change cannot silently break this.
    $extracted = Get-ChildItem -Path $tmp -Recurse -File -Filter $BinaryName |
      Select-Object -First 1
    if (-not $extracted) { throw "no $BinaryName inside the archive" }

    Install-Binary -Source $extracted.FullName -Label $resolved
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if ($Source) { Install-FromSource } else { Install-Published }
