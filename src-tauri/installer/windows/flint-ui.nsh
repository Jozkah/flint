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
!include "${FLINT_UI}\flint-ui-assets.nsh"
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
Var FlintRadioImg1
Var FlintRadioImg2
Var FlintRadioLbl1
Var FlintRadioLbl2
Var FlintRadioBmp1
Var FlintRadioBmp2
Var FlintLaunchSwitch
Var FlintLaunchSwitchImg
Var FlintDeleteSwitch
Var FlintDeleteSwitchImg
Var ReinstallPageCheck
; Version compare result of the reinstall page: same(0)/upgrading(1)/
; downgrading(-1). Deliberately not $R0, which page helpers may clobber.
Var ReinstallVersionState

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

; Preserves $R0/$R1: the template's reinstall page keeps state in them.
!macro _FlintFitPage hwnd
  Push $R0
  Push $R1
  ${FlintPx} $R0 ${FLINT_W}
  ${FlintPx} $R1 ${FLINT_H}
  System::Call 'user32::SetWindowPos(p ${hwnd}, p 0, i 0, i 0, i R0, i R1, i 0x14)'
  !insertmacro _FlintCtl ${hwnd} NONE BG
  Pop $R1
  Pop $R0
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
  !insertmacro _FlintExtractWizard ${theme} ${scale}
!macroend

; Flint buttons are bitmaps rendered by src-tauri/installer/generate.py from
; the app's own Button (components/ui/button.tsx): the primary gradient, the
; outline surface with --secondary-foreground text, 8px radius, 13px Inter
; medium, 36px tall. That keeps them identical to the app at every DPI scale,
; and a bitmap made with NSD_CreateBitmap is a control nsDialogs owns, so its
; ${NSD_OnClick} is delivered. (A STATIC built with a raw CreateWindowExW is
; not: it looks like a button and never fires.) Buttons are placed by their
; right edge, 8px apart, on the row the app uses for dialog footers.
!define FLINT_FOOT_Y 370
!macro _FlintButton variant slug right y callback
  !define /math _FlintBtnX ${right} - ${FLINT_BTN_W_${variant}_${slug}}
  ${FlintPx} $0 ${_FlintBtnX}
  ${FlintPx} $1 ${y}
  ${FlintPx} $2 ${FLINT_BTN_W_${variant}_${slug}}
  ${FlintPx} $3 36
  ${NSD_CreateBitmap} $0 $1 $2 $3 ""
  Pop $4
  ${NSD_OnClick} $4 ${callback}
  ${NSD_SetImage} $4 "$FlintAssets\btn-${variant}-${slug}.bmp" $5
  !undef _FlintBtnX
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
