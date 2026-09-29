!macro FLINT_UI_FUNCTIONS UN
Function ${UN}FlintGuiInit
  StrCpy $FlintDark 0
  ClearErrors
  ReadRegDWORD $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Themes\Personalize" "AppsUseLightTheme"
  ${IfNot} ${Errors}
  ${AndIf} $0 = 0
    StrCpy $FlintDark 1
  ${EndIf}
  ${If} $FlintDark = 1
    StrCpy $FlintBarRef 0xF4C8A8
    StrCpy $FlintTrackRef 0x2B2522
  ${Else}
    StrCpy $FlintBarRef 0x915B31
    StrCpy $FlintTrackRef 0xF3F0EE
  ${EndIf}

  StrCpy $0 0
  System::Call 'user32::GetDpiForWindow(p $HWNDPARENT) i .r0'
  ${If} $0 < 108
    StrCpy $FlintScale 100
  ${ElseIf} $0 < 132
    StrCpy $FlintScale 125
  ${ElseIf} $0 < 168
    StrCpy $FlintScale 150
  ${Else}
    StrCpy $FlintScale 200
  ${EndIf}

  InitPluginsDir
  CreateDirectory "$PLUGINSDIR\flint"
  !insertmacro _FlintExtract light 100
  !insertmacro _FlintExtract light 125
  !insertmacro _FlintExtract light 150
  !insertmacro _FlintExtract light 200
  !insertmacro _FlintExtract dark 100
  !insertmacro _FlintExtract dark 125
  !insertmacro _FlintExtract dark 150
  !insertmacro _FlintExtract dark 200
  ${If} $FlintDark = 1
    StrCpy $FlintAssets "$PLUGINSDIR\flint\dark\$FlintScale"
  ${Else}
    StrCpy $FlintAssets "$PLUGINSDIR\flint\light\$FlintScale"
  ${EndIf}

  File "/oname=$PLUGINSDIR\flint\inter-regular.ttf" "${FLINT_INTER}\Inter_18pt-Regular.ttf"
  File "/oname=$PLUGINSDIR\flint\inter-medium.ttf" "${FLINT_INTER}\Inter_18pt-Medium.ttf"
  File "/oname=$PLUGINSDIR\flint\inter-semibold.ttf" "${FLINT_INTER}\Inter_18pt-SemiBold.ttf"
  System::Call 'gdi32::AddFontResourceExW(w "$PLUGINSDIR\flint\inter-regular.ttf", i 0x10, p 0)'
  System::Call 'gdi32::AddFontResourceExW(w "$PLUGINSDIR\flint\inter-medium.ttf", i 0x10, p 0)'
  System::Call 'gdi32::AddFontResourceExW(w "$PLUGINSDIR\flint\inter-semibold.ttf", i 0x10, p 0)'
  !insertmacro _FlintFont $FlintFontDisplay "Inter 18pt SemiBold" 600 30
  !insertmacro _FlintFont $FlintFontTitle "Inter 18pt SemiBold" 600 20
  !insertmacro _FlintFont $FlintFontBody "Inter 18pt" 400 13
  !insertmacro _FlintFont $FlintFontBodyMedium "Inter 18pt Medium" 500 13
  !insertmacro _FlintFont $FlintFontSmall "Inter 18pt" 400 12
  !insertmacro _FlintFont $FlintFontTiny "Inter 18pt" 400 11

  ; Resource 103 is produced from src-tauri/icons/icon.ico. Use it for both the
  ; title bar and the large brand mark so the installer can never drift to a
  ; generated/approximate logo.
  System::Call 'kernel32::GetModuleHandleW(p 0) p .r0'
  ${FlintPx} $1 32
  System::Call 'user32::LoadImageW(p r0, p 103, i 1, i r1, i r1, i 0) p .r0'
  StrCpy $FlintIcon $0
  ${FlintPx} $1 92
  System::Call 'kernel32::GetModuleHandleW(p 0) p .r0'
  System::Call 'user32::LoadImageW(p r0, p 103, i 1, i r1, i r1, i 0) p .r0'
  StrCpy $FlintHeroIcon $0
  SendMessage $HWNDPARENT ${WM_SETICON} 0 $FlintIcon
  SendMessage $HWNDPARENT ${WM_SETICON} 1 $FlintIcon
  SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:${PRODUCTNAME} Setup"

  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i $FlintDark, i 4)'
  ${If} $FlintDark = 1
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i 0x0D0B0A, i 4)'
  ${Else}
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i 0xF8F8F8, i 4)'
  ${EndIf}

  ; Hide MUI chrome. The native buttons stay alive off-screen for keyboard/page
  ; semantics and as a failure escape hatch.
  !insertmacro _FlintHide $HWNDPARENT 1018
  !insertmacro _FlintHide $HWNDPARENT 1028
  !insertmacro _FlintHide $HWNDPARENT 1034
  !insertmacro _FlintHide $HWNDPARENT 1035
  !insertmacro _FlintHide $HWNDPARENT 1036
  !insertmacro _FlintHide $HWNDPARENT 1037
  !insertmacro _FlintHide $HWNDPARENT 1038
  !insertmacro _FlintHide $HWNDPARENT 1039
  !insertmacro _FlintHide $HWNDPARENT 1045
  !insertmacro _FlintHide $HWNDPARENT 1256
  ${For} $1 1 3
    GetDlgItem $0 $HWNDPARENT $1
    System::Call 'user32::SetWindowPos(p r0, p 0, i -4000, i 0, i 0, i 0, i 0x15)'
  ${Next}

  ; Size the outer window around our client and keep its centre.
  System::Call '*(i, i, i, i) p .r1'
  System::Call 'user32::GetWindowRect(p $HWNDPARENT, p r1)'
  System::Call '*$1(i .r2, i .r3, i .r4, i .r5)'
  System::Call 'user32::GetClientRect(p $HWNDPARENT, p r1)'
  System::Call '*$1(i, i, i .r6, i .r7)'
  System::Free $1
  IntOp $8 $4 - $2
  IntOp $9 $5 - $3
  IntOp $6 $8 - $6
  IntOp $7 $9 - $7
  ${FlintPx} $R0 ${FLINT_W}
  ${FlintPx} $R1 ${FLINT_H}
  IntOp $6 $6 + $R0
  IntOp $7 $7 + $R1
  IntOp $8 $8 - $6
  IntOp $8 $8 / 2
  IntOp $2 $2 + $8
  IntOp $9 $9 - $7
  IntOp $9 $9 / 2
  IntOp $3 $3 + $9
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r2, i r3, i r6, i r7, i 0x14)'

  ; Defaults for interactive installs. Command-line /NS still wins in the
  ; template and passive/silent flows never show these pages.
  ${If} $FlintDesktopShortcutState == ""
    StrCpy $FlintDesktopShortcutState 1
  ${EndIf}
  ${If} $FlintLaunchState == ""
    StrCpy $FlintLaunchState 1
  ${EndIf}
FunctionEnd

!if "${UN}" == "un."
Function un.onGUIEnd
!else
Function .onGUIEnd
!endif
  System::Call 'gdi32::DeleteObject(p $FlintFontDisplay)'
  System::Call 'gdi32::DeleteObject(p $FlintFontTitle)'
  System::Call 'gdi32::DeleteObject(p $FlintFontBody)'
  System::Call 'gdi32::DeleteObject(p $FlintFontBodyMedium)'
  System::Call 'gdi32::DeleteObject(p $FlintFontSmall)'
  System::Call 'gdi32::DeleteObject(p $FlintFontTiny)'
  System::Call 'user32::DestroyIcon(p $FlintIcon)'
  System::Call 'user32::DestroyIcon(p $FlintHeroIcon)'
  System::Call 'gdi32::RemoveFontResourceExW(w "$PLUGINSDIR\flint\inter-regular.ttf", i 0x10, p 0)'
  System::Call 'gdi32::RemoveFontResourceExW(w "$PLUGINSDIR\flint\inter-medium.ttf", i 0x10, p 0)'
  System::Call 'gdi32::RemoveFontResourceExW(w "$PLUGINSDIR\flint\inter-semibold.ttf", i 0x10, p 0)'
FunctionEnd

; Draw the permanent brand rail and page heading. $FlintPage must be the page
; HWND, $R3 the title and $R4 the subtitle.
Function ${UN}FlintShell
  !insertmacro _FlintFitPage $FlintPage

  ${FlintPx} $0 0
  ${FlintPx} $1 0
  ${FlintPx} $2 ${FLINT_LEFT}
  ${FlintPx} $3 ${FLINT_H}
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x50000000, i r0, i r1, i r2, i r3, p $FlintPage, p 0, p 0, p 0) p .r4'
  !insertmacro _FlintCtl $4 NONE PANEL

  ${FlintPx} $0 70
  ${FlintPx} $1 92
  ${FlintPx} $2 92
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", p 0, i 0x50000003, i r0, i r1, i r2, i r2, p $FlintPage, p 0, p 0, p 0) p .r4'
  SendMessage $4 ${STM_SETIMAGE} ${IMAGE_ICON} $FlintHeroIcon
  !insertmacro _FlintCtl $4 NONE PANEL

  ${FlintPx} $0 32
  ${FlintPx} $1 218
  ${FlintPx} $2 168
  ${FlintPx} $3 30
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "Flint", i 0x50000101, i r0, i r1, i r2, i r3, p $FlintPage, p 0, p 0, p 0) p .r4'
  SendMessage $4 ${WM_SETFONT} $FlintFontTitle 1
  !insertmacro _FlintCtl $4 FG PANEL

  ${FlintPx} $1 252
  ${FlintPx} $3 40
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "Your local AI workspace", i 0x50000101, i r0, i r1, i r2, i r3, p $FlintPage, p 0, p 0, p 0) p .r4'
  SendMessage $4 ${WM_SETFONT} $FlintFontSmall 1
  !insertmacro _FlintCtl $4 MUTED PANEL

  ${FlintPx} $1 398
  ${FlintPx} $3 18
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "Version ${VERSION}", i 0x50000101, i r0, i r1, i r2, i r3, p $FlintPage, p 0, p 0, p 0) p .r4'
  SendMessage $4 ${WM_SETFONT} $FlintFontTiny 1
  !insertmacro _FlintCtl $4 MUTED PANEL

  ${FlintPx} $0 ${FLINT_LEFT}
  ${FlintPx} $1 0
  ${FlintPx} $2 1
  ${FlintPx} $3 ${FLINT_H}
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x50000000, i r0, i r1, i r2, i r3, p $FlintPage, p 0, p 0, p 0) p .r4'
  !insertmacro _FlintCtl $4 NONE BORDER

  ${FlintPx} $0 ${FLINT_RIGHT_X}
  ${FlintPx} $1 42
  ${FlintPx} $2 ${FLINT_RIGHT_W}
  ${FlintPx} $3 44
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w R3, i 0x50000000, i r0, i r1, i r2, i r3, p $FlintPage, p 0, p 0, p 0) p .r4'
  StrCpy $FlintTitle $4
  SendMessage $4 ${WM_SETFONT} $FlintFontDisplay 1
  !insertmacro _FlintCtl $4 FG BG

  ${FlintPx} $1 88
  ${FlintPx} $3 46
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w R4, i 0x50000000, i r0, i r1, i r2, i r3, p $FlintPage, p 0, p 0, p 0) p .r4'
  StrCpy $FlintSubtitle $4
  SendMessage $4 ${WM_SETFONT} $FlintFontBody 1
  !insertmacro _FlintCtl $4 MUTED BG
FunctionEnd
