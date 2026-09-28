; Flint look for the NSIS installer and uninstaller.
;
; The stock MUI wizard is replaced by a single app-styled window: the app icon,
; Inter type, the app's 32px padding, its flat 6px progress bar and, on the
; uninstaller's confirm page, its switch and buttons (pre-rendered by
; generate.py, since Win32 cannot draw them). Colours follow the Windows app
; mode, like the app's "system" theme, and every size is scaled by the monitor
; DPI snapped to one of the rendered bitmap scales.
;
; The MUI header, branding and native buttons are hidden, so only pages that
; draw themselves this way can be shown: the install progress page (the
; installer always runs passive) and the uninstaller's confirm and progress
; pages. The native buttons stay enabled off-screen, and come back if an
; install or uninstall fails, so the window can still be closed.

!include nsDialogs.nsh
!include WinMessages.nsh
!include LogicLib.nsh

; The checkout root, defined by the including template (where CI rewrites it).
!ifndef FLINT_WORKSPACE
  !error "Define FLINT_WORKSPACE before including flint-ui.nsh"
!endif
!define FLINT_UI "${FLINT_WORKSPACE}\src-tauri\installer\windows"
!define FLINT_INTER "${FLINT_WORKSPACE}\web-app\public\fonts\inter"

; The window's client area, and the page padding, at 100%.
!define FLINT_W 480
!define FLINT_H 300
!define FLINT_PAD 32

; Colours from web-app/src/index.css. SetCtlColors takes its colours at compile
; time, so both themes are defined here and _FlintCtl picks one at run time.
!define FLINT_LIGHT_NONE ""
!define FLINT_LIGHT_BG "F8F8F8"      ; --background
!define FLINT_LIGHT_FG "1F2937"      ; --foreground
!define FLINT_LIGHT_FG2 "374151"     ; --fg-2
!define FLINT_LIGHT_MUTED "6B7280"   ; --muted-foreground
!define FLINT_LIGHT_BORDER "E5E7EB"  ; --border
!define FLINT_DARK_NONE ""
!define FLINT_DARK_BG "0A0B0D"
!define FLINT_DARK_FG "E6E8EB"
!define FLINT_DARK_FG2 "C9CED6"
!define FLINT_DARK_MUTED "8A909A"
!define FLINT_DARK_BORDER "23262C"

!define MUI_CUSTOMFUNCTION_GUIINIT FlintGuiInit
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.FlintGuiInit
!ifdef MUI_ICON
  !define /ifndef MUI_UNICON "${MUI_ICON}"
!endif

InstProgressFlags smooth

Var FlintScale      ; 100, 125, 150 or 200
Var FlintDark       ; 1 when Windows is in dark app mode
Var FlintAssets     ; folder holding the bitmaps for this theme and scale
Var FlintBarRef     ; progress colours as COLORREF (0xBBGGRR)
Var FlintTrackRef
Var FlintFontTitle
Var FlintFontBody
Var FlintFontSmall
Var FlintIcon
Var FlintTitle      ; the page title and subtitle labels, reworded when a run fails
Var FlintSubtitle

; ${FlintPx} $out 32 -> 32px at the current scale, rounded.
!macro _FlintPx out px
  IntOp ${out} ${px} * $FlintScale
  IntOp ${out} ${out} + 50
  IntOp ${out} ${out} / 100
!macroend
!define FlintPx "!insertmacro _FlintPx"

; A GDI font `px` pixels tall at the current scale. The Inter faces are loaded
; privately by FlintGuiInit; GDI names each non-regular weight as its own family.
!macro _FlintFont out face weight px
  Push $0
  IntOp $0 ${px} * $FlintScale
  IntOp $0 $0 / -100
  System::Call 'gdi32::CreateFontW(i r0, i 0, i 0, i 0, i ${weight}, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w "${face}") p .s'
  Exch
  Pop $0
  Pop ${out}
!macroend

; SetCtlColors with the named tokens (NONE, BG, FG, FG2, MUTED, BORDER).
!macro _FlintCtl hwnd fg bg
  ${If} $FlintDark = 1
    SetCtlColors ${hwnd} "${FLINT_DARK_${fg}}" "${FLINT_DARK_${bg}}"
  ${Else}
    SetCtlColors ${hwnd} "${FLINT_LIGHT_${fg}}" "${FLINT_LIGHT_${bg}}"
  ${EndIf}
!macroend

!macro _FlintHide parent id
  GetDlgItem $0 ${parent} ${id}
  ShowWindow $0 ${SW_HIDE}
!macroend

; Stretch a page's inner dialog over the whole client area and paint it.
!macro _FlintFitPage hwnd
  ${FlintPx} $R0 ${FLINT_W}
  ${FlintPx} $R1 ${FLINT_H}
  System::Call 'user32::SetWindowPos(p ${hwnd}, p 0, i 0, i 0, i R0, i R1, i 0x14)'
  !insertmacro _FlintCtl ${hwnd} NONE BG
!macroend

!macro _FlintExtract theme scale
  CreateDirectory "$PLUGINSDIR\flint\${theme}\${scale}"
  File "/oname=$PLUGINSDIR\flint\${theme}\${scale}\btn-uninstall.bmp" "${FLINT_UI}\${theme}\${scale}\btn-uninstall.bmp"
  File "/oname=$PLUGINSDIR\flint\${theme}\${scale}\btn-cancel.bmp" "${FLINT_UI}\${theme}\${scale}\btn-cancel.bmp"
  File "/oname=$PLUGINSDIR\flint\${theme}\${scale}\switch-on.bmp" "${FLINT_UI}\${theme}\${scale}\switch-on.bmp"
  File "/oname=$PLUGINSDIR\flint\${theme}\${scale}\switch-off.bmp" "${FLINT_UI}\${theme}\${scale}\switch-off.bmp"
!macroend

; Places button `id` at the right edge $6 (moved left past it) on bottom $7.
!macro _FlintPlaceButton id
  GetDlgItem $0 $HWNDPARENT ${id}
  System::Call '*(i, i, i, i) p .r1'
  System::Call 'user32::GetWindowRect(p r0, p r1)'
  System::Call '*$1(i .r2, i .r3, i .r4, i .r8)'
  System::Free $1
  IntOp $4 $4 - $2
  IntOp $8 $8 - $3
  IntOp $6 $6 - $5
  IntOp $6 $6 - $4
  IntOp $3 $7 - $5
  IntOp $3 $3 - $8
  ; HWND_TOP, SWP_NOSIZE | SWP_SHOWWINDOW | SWP_NOACTIVATE
  System::Call 'user32::SetWindowPos(p r0, p 0, i r6, i r3, i 0, i 0, i 0x51)'
!macroend

!macro FLINT_UI_FUNCTIONS UN
Function ${UN}FlintGuiInit
  ; Theme: follow Windows' app mode (light when unset, as Windows defaults).
  StrCpy $FlintDark 0
  ClearErrors
  ReadRegDWORD $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Themes\Personalize" "AppsUseLightTheme"
  ${IfNot} ${Errors}
  ${AndIf} $0 = 0
    StrCpy $FlintDark 1
  ${EndIf}
  ${If} $FlintDark = 1
    StrCpy $FlintBarRef 0xEBE8E6    ; --primary #E6E8EB
    StrCpy $FlintTrackRef 0x2B2522  ; --track #22252B
  ${Else}
    StrCpy $FlintBarRef 0x37291F    ; --primary #1F2937
    StrCpy $FlintTrackRef 0xF3F0EE  ; --track #EEF0F3
  ${EndIf}

  ; Scale: the monitor DPI snapped to a rendered bitmap scale. GetDpiForWindow
  ; needs Windows 10 1607; older systems get 100%.
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
  !if "${UN}" == "un."
    !insertmacro _FlintExtract light 100
    !insertmacro _FlintExtract light 125
    !insertmacro _FlintExtract light 150
    !insertmacro _FlintExtract light 200
    !insertmacro _FlintExtract dark 100
    !insertmacro _FlintExtract dark 125
    !insertmacro _FlintExtract dark 150
    !insertmacro _FlintExtract dark 200
  !endif
  ${If} $FlintDark = 1
    StrCpy $FlintAssets "$PLUGINSDIR\flint\dark\$FlintScale"
  ${Else}
    StrCpy $FlintAssets "$PLUGINSDIR\flint\light\$FlintScale"
  ${EndIf}

  ; Inter, loaded for this process only (FR_PRIVATE).
  File "/oname=$PLUGINSDIR\flint\inter-regular.ttf" "${FLINT_INTER}\Inter_18pt-Regular.ttf"
  File "/oname=$PLUGINSDIR\flint\inter-semibold.ttf" "${FLINT_INTER}\Inter_18pt-SemiBold.ttf"
  System::Call 'gdi32::AddFontResourceExW(w "$PLUGINSDIR\flint\inter-regular.ttf", i 0x10, p 0)'
  System::Call 'gdi32::AddFontResourceExW(w "$PLUGINSDIR\flint\inter-semibold.ttf", i 0x10, p 0)'
  !insertmacro _FlintFont $FlintFontTitle "Inter 18pt SemiBold" 600 20
  !insertmacro _FlintFont $FlintFontBody "Inter 18pt" 400 13
  !insertmacro _FlintFont $FlintFontSmall "Inter 18pt" 400 12

  ; The exe's own icon (resource 103), so beta and nightly builds show theirs.
  System::Call 'kernel32::GetModuleHandleW(p 0) p .r0'
  ${FlintPx} $1 40
  System::Call 'user32::LoadImageW(p r0, p 103, i 1, i r1, i r1, i 0) p .r0'
  StrCpy $FlintIcon $0

  ; Title bar: dark mode, and on Windows 11 the page colour (no-ops elsewhere).
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i $FlintDark, i 4)'
  ${If} $FlintDark = 1
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i 0x0D0B0A, i 4)'
  ${Else}
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i 0xF8F8F8, i 4)'
  ${EndIf}

  ; Hide the MUI chrome: page frame, header, lines and branding text.
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

  ; Park the native Back/Next/Cancel off-screen but enabled.
  ${For} $1 1 3
    GetDlgItem $0 $HWNDPARENT $1
    System::Call 'user32::SetWindowPos(p r0, p 0, i -4000, i 0, i 0, i 0, i 0x15)'
  ${Next}

  ; Resize the window to the Flint client size, keeping its centre.
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
FunctionEnd

!if "${UN}" == "un."
Function un.onGUIEnd
!else
Function .onGUIEnd
!endif
  System::Call 'gdi32::DeleteObject(p $FlintFontTitle)'
  System::Call 'gdi32::DeleteObject(p $FlintFontBody)'
  System::Call 'gdi32::DeleteObject(p $FlintFontSmall)'
  System::Call 'user32::DestroyIcon(p $FlintIcon)'
  System::Call 'gdi32::RemoveFontResourceExW(w "$PLUGINSDIR\flint\inter-regular.ttf", i 0x10, p 0)'
  System::Call 'gdi32::RemoveFontResourceExW(w "$PLUGINSDIR\flint\inter-semibold.ttf", i 0x10, p 0)'
FunctionEnd

; Icon, title ($R3) and subtitle ($R4) at the top of page $R2.
Function ${UN}FlintHeader
  ${FlintPx} $0 ${FLINT_PAD}
  ${FlintPx} $1 40
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", p 0, i 0x50000003, i r0, i r0, i r1, i r1, p R2, p 0, p 0, p 0) p .r2'
  SendMessage $2 ${STM_SETIMAGE} ${IMAGE_ICON} $FlintIcon
  !insertmacro _FlintCtl $2 NONE BG

  ${FlintPx} $1 88
  ${FlintPx} $3 416
  ${FlintPx} $4 28
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w R3, i 0x50000000, i r0, i r1, i r3, i r4, p R2, p 0, p 0, p 0) p .r2'
  StrCpy $FlintTitle $2
  SendMessage $2 ${WM_SETFONT} $FlintFontTitle 1
  !insertmacro _FlintCtl $2 FG BG

  ${FlintPx} $1 122
  ${FlintPx} $4 40
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w R4, i 0x50000000, i r0, i r1, i r3, i r4, p R2, p 0, p 0, p 0) p .r2'
  StrCpy $FlintSubtitle $2
  SendMessage $2 ${WM_SETFONT} $FlintFontBody 1
  !insertmacro _FlintCtl $2 MUTED BG
FunctionEnd

; The progress page: header, a muted status line and the app's 6px bar.
Function ${UN}FlintInstFilesShow
  FindWindow $R2 "#32770" "" $HWNDPARENT
  !insertmacro _FlintFitPage $R2
  !insertmacro _FlintHide $R2 1016
  !insertmacro _FlintHide $R2 1027

  !if "${UN}" == "un."
    StrCpy $R3 "Uninstalling ${PRODUCTNAME}"
    StrCpy $R4 "Removing ${PRODUCTNAME} from this computer."
  !else
    StrCpy $R3 "Installing ${PRODUCTNAME}"
    StrCpy $R4 "This only takes a moment. ${PRODUCTNAME} opens when it's ready."
  !endif
  Call ${UN}FlintHeader

  ${FlintPx} $1 ${FLINT_PAD}
  ${FlintPx} $3 416

  GetDlgItem $0 $R2 1006
  ${FlintPx} $2 236
  ${FlintPx} $4 18
  System::Call 'user32::SetWindowPos(p r0, p 0, i r1, i r2, i r3, i r4, i 0x14)'
  SendMessage $0 ${WM_SETFONT} $FlintFontSmall 1
  !insertmacro _FlintCtl $0 MUTED BG

  ; Unthemed, borderless and recoloured, so it reads as the app's flat bar.
  GetDlgItem $0 $R2 1004
  System::Call 'uxtheme::SetWindowTheme(p r0, w " ", w " ")'
  System::Call 'user32::GetWindowLongW(p r0, i -16) i .r5'
  IntOp $5 $5 & 0xFF7FFFFF
  System::Call 'user32::SetWindowLongW(p r0, i -16, i r5)'
  System::Call 'user32::GetWindowLongW(p r0, i -20) i .r5'
  IntOp $5 $5 & 0xFFFDFDFF
  System::Call 'user32::SetWindowLongW(p r0, i -20, i r5)'
  ${FlintPx} $2 262
  ${FlintPx} $4 6
  System::Call 'user32::SetWindowPos(p r0, p 0, i r1, i r2, i r3, i r4, i 0x34)'
  SendMessage $0 0x409 0 $FlintBarRef   ; PBM_SETBARCOLOR
  SendMessage $0 0x2001 0 $FlintTrackRef ; PBM_SETBKCOLOR
FunctionEnd

; On failure, bring the native Cancel (the one NSIS leaves enabled) back above
; the page, bottom right.
Function ${UN}FlintRestoreButtons
  ${FlintPx} $6 ${FLINT_W}
  ${FlintPx} $7 ${FLINT_H}
  ${FlintPx} $5 12
  !insertmacro _FlintPlaceButton 2
  ; The page covers the whole window; let it clip the raised buttons.
  FindWindow $0 "#32770" "" $HWNDPARENT
  System::Call 'user32::GetWindowLongW(p r0, i -16) i .r1'
  IntOp $1 $1 | 0x04000000
  System::Call 'user32::SetWindowLongW(p r0, i -16, i r1)'
  System::Call 'user32::InvalidateRect(p $HWNDPARENT, p 0, i 1)'
FunctionEnd

; Runs as soon as the sections finish. A failed run stays on this page, so it
; says so and gets the native Close back (NSIS ignores WM_CLOSE there).
Function ${UN}FlintInstFilesLeave
  IfAbort 0 flint_done
    !if "${UN}" == "un."
      SendMessage $FlintTitle ${WM_SETTEXT} 0 "STR:Couldn't uninstall ${PRODUCTNAME}"
    !else
      SendMessage $FlintTitle ${WM_SETTEXT} 0 "STR:Couldn't install ${PRODUCTNAME}"
    !endif
    SendMessage $FlintSubtitle ${WM_SETTEXT} 0 "STR:The reason is shown below. Close this window and try again."
    FindWindow $0 "#32770" "" $HWNDPARENT
    !insertmacro _FlintHide $0 1004
    Call ${UN}FlintRestoreButtons
  flint_done:
FunctionEnd
!macroend

; The uninstaller's confirm page, with the app's switch for deleting app data
; and its outline and destructive buttons. Leaves 1 or 0 in `stateVar`.
!macro FLINT_UNINSTALL_CONFIRM_PAGE stateVar
Var FlintToggle
Var FlintToggleImg
Var FlintToggleState
Var FlintBtnImgA
Var FlintBtnImgB

UninstPage custom un.FlintConfirm un.FlintConfirmLeave

Function un.FlintConfirm
  ${IfThen} $PassiveMode = 1 ${|} Abort ${|}
  nsDialogs::Create 1018
  Pop $R2
  ${If} $R2 == error
    Abort
  ${EndIf}
  !insertmacro _FlintFitPage $R2

  StrCpy $R3 "Uninstall ${PRODUCTNAME}"
  StrCpy $R4 "${PRODUCTNAME} will be removed from this computer. Your chats, models and settings are kept unless you turn on the option below."
  Call un.FlintHeader

  ; Switch row.
  ${FlintPx} $0 ${FLINT_PAD}
  ${FlintPx} $1 180
  ${FlintPx} $2 30
  ${FlintPx} $3 18
  ${NSD_CreateBitmap} $0 $1 $2 $3 ""
  Pop $FlintToggle
  ${If} $FlintToggleState = 1
    ${NSD_SetImage} $FlintToggle "$FlintAssets\switch-on.bmp" $FlintToggleImg
  ${Else}
    ${NSD_SetImage} $FlintToggle "$FlintAssets\switch-off.bmp" $FlintToggleImg
  ${EndIf}
  ${NSD_OnClick} $FlintToggle un.FlintToggleClick

  ${FlintPx} $0 72
  ${FlintPx} $1 179
  ${FlintPx} $2 376
  ${FlintPx} $3 20
  ${NSD_CreateLabel} $0 $1 $2 $3 "$(deleteAppData)"
  Pop $4
  SendMessage $4 ${WM_SETFONT} $FlintFontBody 1
  !insertmacro _FlintCtl $4 FG2 BG
  ${NSD_OnClick} $4 un.FlintToggleClick

  ; Footer: a hairline, then Cancel (outline) and Uninstall (destructive).
  ${FlintPx} $1 232
  ${FlintPx} $2 ${FLINT_W}
  ${FlintPx} $3 1
  ${NSD_CreateLabel} 0 $1 $2 $3 ""
  Pop $4
  !insertmacro _FlintCtl $4 NONE BORDER

  ${FlintPx} $1 248
  ${FlintPx} $2 88
  ${FlintPx} $3 36
  ${FlintPx} $0 372
  ${NSD_CreateBitmap} $0 $1 $2 $3 ""
  Pop $4
  ${NSD_SetImage} $4 "$FlintAssets\btn-uninstall.bmp" $FlintBtnImgA
  ${NSD_OnClick} $4 un.FlintNext
  ${FlintPx} $0 276
  ${NSD_CreateBitmap} $0 $1 $2 $3 ""
  Pop $4
  ${NSD_SetImage} $4 "$FlintAssets\btn-cancel.bmp" $FlintBtnImgB
  ${NSD_OnClick} $4 un.FlintCancel

  nsDialogs::Show
  ${NSD_FreeImage} $FlintToggleImg
  ${NSD_FreeImage} $FlintBtnImgA
  ${NSD_FreeImage} $FlintBtnImgB
FunctionEnd

Function un.FlintToggleClick
  Pop $0
  ${NSD_FreeImage} $FlintToggleImg
  ${If} $FlintToggleState = 1
    StrCpy $FlintToggleState 0
    ${NSD_SetImage} $FlintToggle "$FlintAssets\switch-off.bmp" $FlintToggleImg
  ${Else}
    StrCpy $FlintToggleState 1
    ${NSD_SetImage} $FlintToggle "$FlintAssets\switch-on.bmp" $FlintToggleImg
  ${EndIf}
FunctionEnd

Function un.FlintNext
  Pop $0
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
FunctionEnd

Function un.FlintCancel
  Pop $0
  SendMessage $HWNDPARENT ${WM_COMMAND} 2 0
FunctionEnd

Function un.FlintConfirmLeave
  IntOp ${stateVar} $FlintToggleState + 0
FunctionEnd
!macroend
