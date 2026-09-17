<#
.SYNOPSIS
    One-command setup and build for Flint on Windows.

.DESCRIPTION
    Takes a fresh clone of this repository to a working Flint desktop
    installer, even on a machine that has never built anything before. It
    checks for the tools Flint needs (Git, Node.js, Rust with the MSVC
    toolchain, and the Visual Studio 2022 C++ Build Tools), installs the
    missing ones with winget, then installs the project dependencies and
    produces the installer.

    Safe to run more than once: anything already installed is left alone.

.PARAMETER SkipInstall
    Skip the prerequisite check and install step. Use this when you know the
    tools are already present and only want to build.

.PARAMETER EngineVariant
    Passed through as JAN_ENGINE_VARIANT. Leave unset for the default
    (prebuilt CPU/Vulkan worker, no extra toolchain needed). Set to cuda12,
    cuda13, rocm, etc. only if you want to compile the GPU engine yourself.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\build-windows.ps1

    The whole thing: install what is missing, then build the installer.

.EXAMPLE
    .\build-windows.ps1 -SkipInstall

    Just build, assuming the tools are already installed.
#>
[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [string]$EngineVariant
)

$ErrorActionPreference = 'Stop'

function Write-Step   ($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-Ok     ($m) { Write-Host "    $m"   -ForegroundColor Green }
function Write-Note   ($m) { Write-Host "    $m"   -ForegroundColor DarkGray }
function Write-Warn2  ($m) { Write-Host "    $m"   -ForegroundColor Yellow }

function Test-Cmd ($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# Run from the repository root regardless of where the script is invoked from.
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoRoot
if (-not (Test-Path (Join-Path $RepoRoot 'package.json'))) {
    throw "package.json not found in $RepoRoot -- run this script from inside the cloned repository."
}

Write-Host ""
Write-Host "  Flint - Windows setup and build" -ForegroundColor White
Write-Host "  Repository: $RepoRoot" -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# 1. Prerequisites
# ---------------------------------------------------------------------------
if (-not $SkipInstall) {
    Write-Step "Checking prerequisites"

    if (-not (Test-Cmd winget)) {
        throw @"
winget (the Windows Package Manager) was not found. It ships with the
"App Installer" package from the Microsoft Store on Windows 10/11.

Install App Installer from the Microsoft Store, then run this script again.
Alternatively install Git, Node.js 20+, Rust, and the Visual Studio 2022
C++ Build Tools by hand and re-run with -SkipInstall.
"@
    }

    # id, friendly name, the command that proves it is present, optional winget override
    $tools = @(
        @{ Id = 'Git.Git';                                  Name = 'Git';                Probe = 'git';    Override = $null },
        @{ Id = 'OpenJS.NodeJS.LTS';                        Name = 'Node.js (LTS)';      Probe = 'node';   Override = $null },
        @{ Id = 'Rustlang.Rustup';                          Name = 'Rust (rustup)';      Probe = 'rustc';  Override = $null },
        @{ Id = 'Microsoft.VisualStudio.2022.BuildTools';   Name = 'VS 2022 Build Tools';Probe = $null;    Override = '--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.Windows11SDK.22621 --includeRecommended' }
    )

    foreach ($t in $tools) {
        $present = $false
        if ($t.Probe) {
            $present = Test-Cmd $t.Probe
        } else {
            # VS Build Tools: probe with vswhere if available.
            $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
            if (Test-Path $vswhere) {
                $found = & $vswhere -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
                $present = [bool]$found
            }
        }

        if ($present) {
            Write-Ok "$($t.Name) already installed."
            continue
        }

        Write-Note "$($t.Name) not found -- installing with winget ($($t.Id))..."
        $args = @('install', '--id', $t.Id, '-e', '--source', 'winget',
                  '--accept-package-agreements', '--accept-source-agreements')
        if ($t.Override) { $args += @('--override', $t.Override) }
        winget @args
        if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) {
            # -1978335189 = "no applicable upgrade / already installed"; treat as fine.
            throw "winget failed to install $($t.Name) (exit $LASTEXITCODE)."
        }
        Write-Ok "$($t.Name) installed."
    }

    # Rust must use the MSVC host toolchain to link against the Windows SDK.
    if (Test-Cmd rustup) {
        Write-Note "Ensuring the Rust stable-msvc toolchain is the default..."
        rustup default stable-msvc | Out-Null
        rustup toolchain install stable-msvc | Out-Null
    }

    Write-Warn2 "If Git, Node, or Rust were just installed, their PATH entries"
    Write-Warn2 "may not be live in this window. If the build below cannot find"
    Write-Warn2 "one of them, open a NEW terminal and re-run with -SkipInstall."
}

# ---------------------------------------------------------------------------
# 2. Sanity check the toolchain is reachable
# ---------------------------------------------------------------------------
Write-Step "Verifying tools are on PATH"
$missing = @()
foreach ($c in 'git', 'node', 'cargo') { if (-not (Test-Cmd $c)) { $missing += $c } }
if ($missing.Count -gt 0) {
    throw @"
These tools are not on PATH in this window: $($missing -join ', ').
Open a new terminal (so freshly installed tools are picked up) and run:
    .\build-windows.ps1 -SkipInstall
"@
}
Write-Ok "git  $(git --version)"
Write-Ok "node $(node --version)"
Write-Ok "$(cargo --version)"

# ---------------------------------------------------------------------------
# 3. Yarn via Corepack (the repo pins its own Yarn version)
# ---------------------------------------------------------------------------
Write-Step "Enabling Yarn through Corepack"
corepack enable
Write-Ok "$(yarn --version) (pinned by the repository)"

# ---------------------------------------------------------------------------
# 4. Install dependencies
# ---------------------------------------------------------------------------
Write-Step "Installing project dependencies (yarn install)"
Write-Note "First run downloads a lot; later runs are fast."
yarn install --immutable
Write-Ok "Dependencies installed."

# ---------------------------------------------------------------------------
# 5. Build the desktop installer
# ---------------------------------------------------------------------------
Write-Step "Building Flint (this compiles Rust and can take 10-30 minutes the first time)"
if ($EngineVariant) {
    Write-Note "JAN_ENGINE_VARIANT=$EngineVariant"
    $env:JAN_ENGINE_VARIANT = $EngineVariant
}
yarn build
Write-Ok "Build finished."

# ---------------------------------------------------------------------------
# 6. Show what was produced
# ---------------------------------------------------------------------------
Write-Step "Done -- your installer is here"
$bundle = Join-Path $RepoRoot 'src-tauri\target\release\bundle'
$artifacts = @()
if (Test-Path $bundle) {
    $artifacts = Get-ChildItem -Path $bundle -Recurse -Include '*.exe', '*.msi' -ErrorAction SilentlyContinue
}
if ($artifacts.Count -gt 0) {
    foreach ($a in $artifacts) { Write-Host "    $($a.FullName)" -ForegroundColor Green }
    Write-Host ""
    Write-Host "  Run one of the installers above to install Flint," -ForegroundColor White
    Write-Host "  or launch the app directly from:" -ForegroundColor White
    Write-Host "    $RepoRoot\src-tauri\target\release\Flint.exe" -ForegroundColor Green
} else {
    Write-Warn2 "No installer found under $bundle."
    Write-Warn2 "Check the build output above for errors."
    exit 1
}
