; Flint installer UI for NSIS.
;
; The interactive installer is a real Flint-styled wizard instead of the stock
; MUI pages. It uses the app's actual executable icon, Inter, app colours,
; spacing, switches and pre-rendered button surfaces. Silent/passive installs
; keep their existing no-UI behaviour. The uninstaller uses the same shell.

!include nsDialogs.nsh
!include WinMessages.nsh
!include LogicLib.nsh

!ifndef FLINT_WORKSPACE
  !error "Define FLINT_WORKSPACE before including flint-ui.nsh"
!endif
!define FLINT_UI "${FLINT_WORKSPACE}\src-tauri\installer\windows"
!define FLINT_INTER "${FLINT_WORKSPACE}\web-app\public\fonts\inter"

; 720x440 keeps the mockup proportions while still fitting a 1080p monitor at
; 150% scaling. At 200% the client is 1440x880.
!define FLINT_W 720
!define FLINT_H 440
!define FLINT_LEFT 232
!define FLINT_PAD 32
!define FLINT_RIGHT_X 264
!define FLINT_RIGHT_W 424

; App tokens (web-app/src/index.css). These are compile-time because
; SetCtlColors does not accept a runtime colour value.
!define FLINT_LIGHT_NONE ""
!define FLINT_LIGHT_BG "F8F8F8"
!define FLINT_LIGHT_PANEL "EEF2F7"
!define FLINT_LIGHT_CARD "FFFFFF"
!define FLINT_LIGHT_FG "1F2937"
!define FLINT_LIGHT_FG2 "374151"
!define FLINT_LIGHT_MUTED "6B7280"
!define FLINT_LIGHT_BORDER "E5E7EB"
!define FLINT_LIGHT_SUCCESS "15803D"
!define FLINT_LIGHT_ACCENT "1F2937"
!define FLINT_LIGHT_ACCENT_TOP "37475D"
!define FLINT_LIGHT_ONACCENT "FFFFFF"
!define FLINT_DARK_NONE ""
!define FLINT_DARK_BG "0A0B0D"
!define FLINT_DARK_PANEL "111821"
!define FLINT_DARK_CARD "131519"
!define FLINT_DARK_FG "F3F4F6"
!define FLINT_DARK_FG2 "C9CED6"
!define FLINT_DARK_MUTED "8A909A"
!define FLINT_DARK_BORDER "30343B"
!define FLINT_DARK_SUCCESS "6EE7A0"
!define FLINT_DARK_ACCENT "A8C8F4"
!define FLINT_DARK_ACCENT_TOP "6F8FBE"
!define FLINT_DARK_ONACCENT "111318"

!define MUI_CUSTOMFUNCTION_GUIINIT FlintGuiInit
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.FlintGuiInit
!ifdef MUI_ICON
  !define /ifndef MUI_UNICON "${MUI_ICON}"
!endif

InstProgressFlags smooth

Var FlintScale
Var FlintDark
Var FlintAssets
Var FlintBarRef
Var FlintTrackRef
Var FlintFontDisplay
Var FlintFontTitle
Var FlintFontBody
Var FlintFontBodyMedium
Var FlintFontSmall
Var FlintFontTiny
Var FlintIcon
Var FlintHeroIcon
Var FlintPage
Var FlintTitle
Var FlintSubtitle
Var FlintPathEdit
Var FlintDesktopShortcutState
Var FlintDesktopSwitch
Var FlintDesktopSwitchImg
Var FlintLaunchState
Var FlintLaunchSwitch
Var FlintLaunchSwitchImg
Var FlintDeleteSwitch
Var FlintDeleteSwitchImg
Var FlintFinishLaunchState
Var ReinstallPageCheck

!macro _FlintPx out px
  IntOp ${out} ${px} * $FlintScale
  IntOp ${out} ${out} + 50
  IntOp ${out} ${out} / 100
!macroend
!define FlintPx "!insertmacro _FlintPx"

!macro _FlintFont out face weight px
  Push $0
  IntOp $0 ${px} * $FlintScale
  IntOp $0 $0 / -100
  System::Call 'gdi32::CreateFontW(i r0, i 0, i 0, i 0, i ${weight}, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w "${face}") p .s'
  Exch
  Pop $0
  Pop ${out}
!macroend

!macro _FlintCtl hwnd fg bg
  ${If} $FlintDark = 1
    SetCtlColors ${hwnd} "${FLINT_DARK_${fg}}" "${FLINT_DARK_${bg}}"
  ${Else}
    SetCtlColors ${hwnd} "${FLINT_LIGHT_${fg}}" "${FLINT_LIGHT_${bg}}"
  ${EndIf}
!macroend

!macro _FlintCtlTransparent hwnd fg
  ${If} $FlintDark = 1
    SetCtlColors ${hwnd} "${FLINT_DARK_${fg}}" transparent
  ${Else}
    SetCtlColors ${hwnd} "${FLINT_LIGHT_${fg}}" transparent
  ${EndIf}
!macroend

!macro _FlintHide parent id
  GetDlgItem $0 ${parent} ${id}
  ShowWindow $0 ${SW_HIDE}
!macroend

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

; App-style buttons are built from ordinary Win32 statics so the label always
; uses the privately loaded Inter face. The primary uses two accent bands to
; reproduce Flint's subtle vertical gradient without shipping per-label bitmaps.
!macro _FlintPrimaryButton x y label callback
  ${FlintPx} $0 ${x}
  ${FlintPx} $1 ${y}
  ${FlintPx} $2 132
  ${FlintPx} $3 40
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x50000100, i r0, i r1, i r2, i r3, p $FlintPage, p 0, p 0, p 0) p .r4'
  !insertmacro _FlintCtl $4 NONE ACCENT
  ${NSD_OnClick} $4 ${callback}
  IntOp $5 $3 / 2
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x50000000, i r0, i r1, i r2, i r5, p $FlintPage, p 0, p 0, p 0) p .r6'
  !insertmacro _FlintCtl $6 NONE ACCENT_TOP
  ${NSD_OnClick} $6 ${callback}
  IntOp $7 $1 + $5
  IntOp $8 $3 - $5
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x50000000, i r0, i r7, i r2, i r8, p $FlintPage, p 0, p 0, p 0) p .r6'
  !insertmacro _FlintCtl $6 NONE ACCENT
  ${NSD_OnClick} $6 ${callback}
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "${label}", i 0x50000301, i r0, i r1, i r2, i r3, p $FlintPage, p 0, p 0, p 0) p .r6'
  SendMessage $6 ${WM_SETFONT} $FlintFontBodyMedium 1
  !insertmacro _FlintCtlTransparent $6 ONACCENT
  ${NSD_OnClick} $6 ${callback}
!macroend

!macro _FlintSecondaryButton x y label callback
  ${FlintPx} $0 ${x}
  ${FlintPx} $1 ${y}
  ${FlintPx} $2 132
  ${FlintPx} $3 40
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x50000100, i r0, i r1, i r2, i r3, p $FlintPage, p 0, p 0, p 0) p .r4'
  !insertmacro _FlintCtl $4 NONE BORDER
  ${NSD_OnClick} $4 ${callback}
  IntOp $0 $0 + 1
  IntOp $1 $1 + 1
  IntOp $2 $2 - 2
  IntOp $3 $3 - 2
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x50000100, i r0, i r1, i r2, i r3, p $FlintPage, p 0, p 0, p 0) p .r4'
  !insertmacro _FlintCtl $4 NONE CARD
  ${NSD_OnClick} $4 ${callback}
  IntOp $0 $0 - 1
  IntOp $1 $1 - 1
  IntOp $2 $2 + 2
  IntOp $3 $3 + 2
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "${label}", i 0x50000301, i r0, i r1, i r2, i r3, p $FlintPage, p 0, p 0, p 0) p .r6'
  SendMessage $6 ${WM_SETFONT} $FlintFontBodyMedium 1
  !insertmacro _FlintCtlTransparent $6 FG
  ${NSD_OnClick} $6 ${callback}
!macroend

; Reposition one of MUI's native buttons. Used only as a failure escape hatch;
; the normal interactive pages use the Flint buttons above.
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
  System::Call 'user32::SetWindowPos(p r0, p 0, i r6, i r3, i 0, i 0, i 0x51)'
!macroend


!include "${FLINT_UI}\flint-ui-runtime.nsh"
!include "${FLINT_UI}\flint-ui-pages.nsh"
!include "${FLINT_UI}\flint-ui-uninstall.nsh"
