# Name of the process that owns the top-level window under a screen point, or the
# visible app names. Input stays in environment variables, never evaluated.
$ErrorActionPreference = 'Stop'
if ($env:FLINT_APP_MODE -eq 'list') {
  Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object -ExpandProperty ProcessName -Unique | Sort-Object
  return
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FlintApp {
  [StructLayout(LayoutKind.Sequential)] public struct Pt { public int x, y; }
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Pt p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static int PidAt(int x, int y) {
    IntPtr h = WindowFromPoint(new Pt { x = x, y = y });
    if (h == IntPtr.Zero) return 0;
    IntPtr root = GetAncestor(h, 2);
    if (root != IntPtr.Zero) h = root;
    uint pid; GetWindowThreadProcessId(h, out pid); return (int)pid;
  }
}
'@
[FlintApp]::SetProcessDPIAware() | Out-Null
$id = [FlintApp]::PidAt([int]$env:FLINT_APP_X, [int]$env:FLINT_APP_Y)
if ($id -eq 0) { return }
(Get-Process -Id $id -ErrorAction Stop).ProcessName
