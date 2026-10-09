# Input stays in an environment variable and is parsed as JSON, never evaluated.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FlintInput {
  [StructLayout(LayoutKind.Sequential)] public struct Mouse { public int x,y; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct Keyboard { public ushort key,scan; public uint flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct Union { [FieldOffset(0)] public Mouse mouse; [FieldOffset(0)] public Keyboard keyboard; }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint type; public Union value; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] input, int size);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  static void Send(Input input) { if (SendInput(1, new [] {input}, Marshal.SizeOf(typeof(Input))) != 1) throw new Exception("Input refused by Windows. Elevated apps and the secure desktop cannot be controlled from Flint."); }
  public static void Key(ushort key, bool up) { var i = new Input(); i.type = 1; i.value.keyboard.key = key; i.value.keyboard.flags = (up ? 2u : 0u) | ((key >= 33 && key <= 46) || key == 91 ? 1u : 0u); Send(i); }
  static void Unicode(ushort scan, bool up) { var i = new Input(); i.type = 1; i.value.keyboard.scan = scan; i.value.keyboard.flags = 4u | (up ? 2u : 0u); Send(i); }
  public static void Text(string text) { foreach (char c in text) { if (c == '\r') continue; if (c == '\n' || c == '\t') { ushort key = (ushort)(c == '\n' ? 13 : 9); Key(key,false); Key(key,true); } else { Unicode(c,false); Unicode(c,true); } } }
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  // A real absolute pointer move (SetCursorPos alone raises no input event, so
  // games that read mouse input never see the pointer arrive).
  public static bool MoveTo(int x, int y) {
    if (!SetCursorPos(x, y)) return false;
    int w = Math.Max(GetSystemMetrics(0) - 1, 1), h = Math.Max(GetSystemMetrics(1) - 1, 1);
    var i = new Input(); i.type = 0; i.value.mouse.flags = 0x8001;
    i.value.mouse.x = (int)(((long)x * 65535 + w / 2) / w); i.value.mouse.y = (int)(((long)y * 65535 + h / 2) / h);
    Send(i); return true;
  }
  public static void MouseEvent(uint flags, int data) { var i = new Input(); i.type = 0; i.value.mouse.flags = flags; i.value.mouse.data = unchecked((uint)data); Send(i); }
}
'@
[FlintInput]::SetProcessDPIAware() | Out-Null
$p = $env:FLINT_COMPUTER_INPUT | ConvertFrom-Json
switch ($p.action) {
  'screenshot' {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $r = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $image = New-Object System.Drawing.Bitmap $r.Width, $r.Height
    $graphics = [System.Drawing.Graphics]::FromImage($image)
    try { $graphics.CopyFromScreen($r.Location, [System.Drawing.Point]::Empty, $r.Size); $image.Save($env:FLINT_COMPUTER_CAPTURE, [System.Drawing.Imaging.ImageFormat]::Png) }
    finally { $graphics.Dispose(); $image.Dispose() }
  }
  'move' { if (-not [FlintInput]::MoveTo($p.x,$p.y)) { throw 'Pointer move failed' }; Start-Sleep -Milliseconds 60 }
  'click' {
    if (-not [FlintInput]::MoveTo($p.x,$p.y)) { throw 'Pointer move failed' }; Start-Sleep -Milliseconds 60
    $down = @{left=2; right=8; middle=32}[$p.button]
    for ($n=0; $n -lt $p.count; $n++) { [FlintInput]::MouseEvent($down,0); Start-Sleep -Milliseconds 60; [FlintInput]::MouseEvent($down*2,0); if ($n+1 -lt $p.count) { Start-Sleep -Milliseconds 100 } }
  }
  'type' { if (-not [FlintInput]::MoveTo($p.x,$p.y)) { throw 'Pointer move failed' }; Start-Sleep -Milliseconds 60; [FlintInput]::MouseEvent(2,0); Start-Sleep -Milliseconds 60; [FlintInput]::MouseEvent(4,0); if ($p.replace) { [FlintInput]::Key(17,$false); try { [FlintInput]::Key(65,$false); [FlintInput]::Key(65,$true) } finally { [FlintInput]::Key(17,$true) } }; [FlintInput]::Text($p.text) }
  'key' {
    if (-not [FlintInput]::MoveTo($p.x,$p.y)) { throw 'Pointer move failed' }; Start-Sleep -Milliseconds 60; [FlintInput]::MouseEvent(2,0); Start-Sleep -Milliseconds 60; [FlintInput]::MouseEvent(4,0)
    $map = @{ctrl=17; alt=18; shift=16; meta=91; enter=13; tab=9; escape=27; backspace=8; delete=46; space=32; up=38; down=40; left=37; right=39; home=36; end=35; pageup=33; pagedown=34}
    $pressed = New-Object 'System.Collections.Generic.List[UInt16]'
    try { foreach ($key in $p.keys) { $code = if ($map.ContainsKey($key)) { $map[$key] } else { [int][char]$key.ToUpperInvariant() }; [FlintInput]::Key($code,$false); $pressed.Add($code) } }
    finally { for ($n=$pressed.Count-1; $n -ge 0; $n--) { try { [FlintInput]::Key($pressed[$n],$true) } catch {} } }
  }
  'scroll' { if (-not [FlintInput]::MoveTo($p.x,$p.y)) { throw 'Pointer move failed' }; Start-Sleep -Milliseconds 60; [FlintInput]::MouseEvent(2,0); Start-Sleep -Milliseconds 60; [FlintInput]::MouseEvent(4,0); [FlintInput]::MouseEvent(2048,-120*$p.amount) }
}
