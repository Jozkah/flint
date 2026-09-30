param(
    [Parameter(Mandatory = $true)]
    [string]$Workspace,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^S-1-15-2-(?:[0-9]+-){6}[0-9]+$')]
    [string]$PackageSid,
    [string]$LogPath,
    # Where Flint keeps agent workspaces. Defaults to the standard install
    # location; pass it (or set FLINT_AGENT_WORKSPACE_ROOT) when the data
    # folder was moved.
    [string]$WorkspaceRoot,
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
if ($Apply) {
    $principal = [System.Security.Principal.WindowsPrincipal]::new([System.Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Apply requires an elevated PowerShell window.'
    }
}
$workspacePath = [System.IO.Path]::GetFullPath($Workspace)
if (-not (Test-Path -LiteralPath $workspacePath -PathType Container)) {
    throw "Workspace does not exist: $workspacePath"
}
if (-not $WorkspaceRoot) { $WorkspaceRoot = $env:FLINT_AGENT_WORKSPACE_ROOT }
if (-not $WorkspaceRoot) { $WorkspaceRoot = Join-Path $env:APPDATA 'Jan\data\agent-workspace' }
$workspaceRoot = [System.IO.Path]::GetFullPath($WorkspaceRoot).TrimEnd('\')
if (-not $workspacePath.StartsWith($workspaceRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    # This script changes permissions on every folder above the workspace, so
    # it only runs for a folder Flint itself made: a wrong path would open
    # unrelated folders to the sandbox.
    throw "Refusing $workspacePath because it is not under the Flint agent-workspace folder $workspaceRoot. If your Flint data folder is elsewhere, pass -WorkspaceRoot (or set FLINT_AGENT_WORKSPACE_ROOT) to that agent-workspace folder."
}

$sid = [System.Security.Principal.SecurityIdentifier]::new($PackageSid)
$acl = Get-Acl -LiteralPath $workspacePath
$rules = $acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier])
if (-not @($rules | Where-Object {
    $_.IdentityReference -eq $sid -and
    $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow
}).Count) {
    throw "Package SID has no explicit workspace grant: $PackageSid"
}

$directory = [System.IO.DirectoryInfo]::new($workspacePath).Parent
$parents = [System.Collections.Generic.List[string]]::new()
while ($null -ne $directory) {
    $parents.Add($directory.FullName)
    $directory = $directory.Parent
}
$parents.Reverse()
# Traverse-only, on the directory itself (no inheritance): passing through a
# parent must not let the sandbox list what is in the drive root, Users or
# Roaming.
$grant = '*' + $PackageSid + ':(X)'
foreach ($path in $parents) {
    if (-not $Apply) {
        Write-Output "Would grant directory-only traverse (X) to $PackageSid on $path"
        continue
    }
    if ($LogPath) { "Checking $path" | Add-Content -LiteralPath $LogPath }
    $parentAcl = Get-Acl -LiteralPath $path
    $hasTraverse = @($parentAcl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) |
        Where-Object {
            $_.IdentityReference -eq $sid -and
            $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
            ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::Traverse) -eq
                [System.Security.AccessControl.FileSystemRights]::Traverse
        }).Count -gt 0
    if ($hasTraverse) {
        if ($LogPath) { "Already granted $path" | Add-Content -LiteralPath $LogPath }
        continue
    }
    & icacls.exe $path /grant $grant
    if ($LASTEXITCODE -ne 0) {
        throw "icacls failed for $path with exit code $LASTEXITCODE"
    }
    if ($LogPath) { "Granted $path" | Add-Content -LiteralPath $LogPath }
}
