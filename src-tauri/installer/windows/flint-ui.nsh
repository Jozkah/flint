; Flint installer UI for NSIS.
;
; The interactive installer is a real Flint-styled wizard instead of the stock
; MUI pages. It uses the app's actual executable icon, Inter, app colours,
; spacing and custom controls. Silent/passive installs keep their existing
; no-UI behaviour. The uninstaller uses the same shell.

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
!define FLINT_RIGHT_X 264
!define FLINT_RIGHT_W 424

; Exact default app tokens from web-app/src/styles/tokens.css. The installer
; follows Windows light/dark mode; user-selected in-app accents are unavailable
; before first launch, so it uses Flint's neutral default accent.
!define FLINT_LIGHT_NONE ""
!define FLINT_LIGHT_BG "F8F8F8"
!define FLINT_LIGHT_PANEL "F6F6F6"
!define FLINT_LIGHT_CARD "FFFFFF"
!define FLINT_LIGHT_FG "1F2937"
!define FLINT_LIGHT_FG2 "374151"
!define FLINT_LIGHT_MUTED "6B7280"
!define FLINT_LIGHT_BORDER "E5E7EB"
!define FLINT_LIGHT_SUCCESS "059669"
!define FLINT_LIGHT_ACCENT "1F2937"
!define FLINT_LIGHT_ONACCENT "FFFFFF"
!define FLINT_DARK_NONE ""
!define FLINT_DARK_BG "0A0B0D"
!define FLINT_DARK_PANEL "0F1114"
!define FLINT_DARK_CARD "131519"
!define FLINT_DARK_FG "E6E8EB"
!define FLINT_DARK_FG2 "C9CED6"
!define FLINT_DARK_MUTED "8A909A"
!define FLINT_DARK_BORDER "23262C"
!define FLINT_DARK_SUCCESS "34D399"
!define FLINT_DARK_ACCENT "E6E8EB"
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

; Round a control using a real Win32 region. SetWindowRgn owns the region on
; success, so it must not be deleted afterwards.
!macro _FlintRound hwnd width height radius
  System::Call 'gdi32::CreateRoundRectRgn(i 0, i 0, i ${width}, i ${height}, i ${radius}, i ${radius}) p .r9'
  System::Call 'user32::SetWindowRgn(p ${hwnd}, p r9, i 1) i .r9'
!macroend

!macro _FlintExtract theme scale
  CreateDirectory "$PLUGINSDIR\flint\${theme}\${scale}"
  File "/oname=$PLUGINSDIR\flint\${theme}\${scale}\btn-uninstall.bmp" "${FLINT_UI}\${theme}\${scale}\btn-uninstall.bmp"
  File "/oname=$PLUGINSDIR\flint\${theme}\${scale}\btn-cancel.bmp" "${FLINT_UI}\${theme}\${scale}\btn-cancel.bmp"
  File "/oname=$PLUGINSDIR\flint\${theme}\${scale}\switch-on.bmp" "${FLINT_UI}\${theme}\${scale}\switch-on.bmp"
  File "/oname=$PLUGINSDIR\flint\${theme}\${scale}\switch-off.bmp" "${FLINT_UI}\${theme}\${scale}\switch-off.bmp"
!macroend

; Custom Flint buttons: no stock Windows button chrome. Primary is the app's
; default --primary surface; secondary is a rounded one-pixel --border shell
; around a --card inner surface. Both use the bundled Inter face.
!macro _FlintPrimaryButton x y label callback
  ${FlintPx} $0 ${x}
  ${FlintPx} $1 ${y}
  ${FlintPx} $2 132
  ${FlintPx} $3 40
  ${FlintPx} $5 8
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "${label}", i 0x50000301, i r0, i r1, i r2, i r3, p $FlintPage, p 0, p 0, p 0) p .r4'
  !insertmacro _FlintRound $4 $2 $3 $5
  SendMessage $4 ${WM_SETFONT} $FlintFontBodyMedium 1
  !insertmacro _FlintCtl $4 ONACCENT ACCENT
  ${NSD_OnClick} $4 ${callback}
!macroend

!macro _FlintSecondaryButton x y label callback
  ${FlintPx} $0 ${x}
  ${FlintPx} $1 ${y}
  ${FlintPx} $2 132
  ${FlintPx} $3 40
  ${FlintPx} $5 8
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x50000100, i r0, i r1, i r2, i r3, p $FlintPage, p 0, p 0, p 0) p .r4'
  !insertmacro _FlintRound $4 $2 $3 $5
  !insertmacro _FlintCtl $4 NONE BORDER
  ${FlintPx} $6 1
  IntOp $7 $2 - $6
  IntOp $7 $7 - $6
  IntOp $8 $3 - $6
  IntOp $8 $8 - $6
  ${FlintPx} $5 7
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "${label}", i 0x50000301, i r6, i r6, i r7, i r8, p r4, p 0, p 0, p 0) p .r6'
  !insertmacro _FlintRound $6 $7 $8 $5
  SendMessage $6 ${WM_SETFONT} $FlintFontBodyMedium 1
  !insertmacro _FlintCtl $6 FG CARD
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
