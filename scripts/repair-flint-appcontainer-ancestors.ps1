param(
    [Parameter(Mandatory = $true)]
    [string]$Workspace,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^S-1-15-2-(?:[0-9]+-){6}[0-9]+$')]
    [string]$PackageSid,
    [string]$LogPath,
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
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $env:APPDATA 'Jan\data\agent-workspace'))
if (-not $workspacePath.StartsWith($workspaceRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing a path outside Flint agent-workspace: $workspacePath"
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
$grant = '*' + $PackageSid + ':(RX)'
foreach ($path in $parents) {
    if (-not $Apply) {
        Write-Output "Would grant directory-only RX to $PackageSid on $path"
        continue
    }
    if ($LogPath) { "Checking $path" | Add-Content -LiteralPath $LogPath }
    $parentAcl = Get-Acl -LiteralPath $path
    $hasRx = @($parentAcl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) |
        Where-Object {
            $_.IdentityReference -eq $sid -and
            $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
            ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::ReadAndExecute) -eq
                [System.Security.AccessControl.FileSystemRights]::ReadAndExecute
        }).Count -gt 0
    if ($hasRx) {
        if ($LogPath) { "Already granted $path" | Add-Content -LiteralPath $LogPath }
        continue
    }
    & icacls.exe $path /grant $grant
    if ($LASTEXITCODE -ne 0) {
        throw "icacls failed for $path with exit code $LASTEXITCODE"
    }
    if ($LogPath) { "Granted $path" | Add-Content -LiteralPath $LogPath }
}
