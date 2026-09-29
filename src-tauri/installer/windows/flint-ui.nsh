; Flint Windows installer UI.
;
; This include replaces the stock welcome, directory and finish pages with a
; Flint-branded wizard while keeping Tauri/NSIS' installation machinery. The
; installer uses the real app icon from the executable, Inter, the app's colour
; tokens, DPI scaling and Windows light/dark mode. Silent and /P installs keep
; the original passive behaviour.

!include nsDialogs.nsh
!include WinMessages.nsh
!include LogicLib.nsh

!ifndef FLINT_WORKSPACE
  !error "Define FLINT_WORKSPACE before including flint-ui.nsh"
!endif
!define FLINT_UI "${FLINT_WORKSPACE}\src-tauri\installer\windows"
!define FLINT_INTER "${FLINT_WORKSPACE}\web-app\public\fonts\inter"

!define FLINT_W 760
!define FLINT_H 500
!define FLINT_CONTENT_H 424
!define FLINT_PAD 36

!define FLINT_LIGHT_NONE ""
!define FLINT_LIGHT_BG "F8F8F8"
!define FLINT_LIGHT_CARD "FFFFFF"
!define FLINT_LIGHT_FG "1F2937"
!define FLINT_LIGHT_FG2 "374151"
!define FLINT_LIGHT_MUTED "6B7280"
!define FLINT_LIGHT_BORDER "E5E7EB"
!define FLINT_DARK_NONE ""
!define FLINT_DARK_BG "0A0B0D"
!define FLINT_DARK_CARD "131519"
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

Var FlintScale
Var FlintDark
Var FlintAssets
Var FlintBarRef
Var FlintTrackRef
Var FlintFontHero
Var FlintFontTitle
Var FlintFontBody
Var FlintFontMedium
Var FlintFontSmall
Var FlintIcon
Var FlintTitle
Var FlintSubtitle
Var FlintInstallDir
Var FlintDesktopShortcut
Var FlintLaunchAfter
Var FlintFinishLaunch

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
  ${FlintPx} $R1 ${FLINT_CONTENT_H}
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

!macro _FlintLabel out parent x y w h text font fg
  ${FlintPx} $0 ${x}
  ${FlintPx} $1 ${y}
  ${FlintPx} $2 ${w}
  ${FlintPx} $3 ${h}
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "${text}", i 0x50000000, i r0, i r1, i r2, i r3, p ${parent}, p 0, p 0, p 0) p .r4'
  StrCpy ${out} $4
  SendMessage $4 ${WM_SETFONT} ${font} 1
  !insertmacro _FlintCtl $4 ${fg} BG
!macroend

Function FlintLayoutButtons
  ${FlintPx} $6 ${FLINT_W}
  ${FlintPx} $7 ${FLINT_H}
  ${FlintPx} $5 14
  !insertmacro _FlintPlaceButton 1
  !insertmacro _FlintPlaceButton 2
  !insertmacro _FlintPlaceButton 3
  ${For} $1 1 3
    GetDlgItem $0 $HWNDPARENT $1
    SendMessage $0 ${WM_SETFONT} $FlintFontMedium 1
  ${Next}
FunctionEnd

Function FlintShowFooter
  ${FlintPx} $0 0
  ${FlintPx} $1 ${FLINT_CONTENT_H}
  ${FlintPx} $2 ${FLINT_W}
  ${FlintPx} $3 1
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x50000000, i r0, i r1, i r2, i r3, p $HWNDPARENT, p 0, p 0, p 0) p .r4'
  !insertmacro _FlintCtl $4 NONE BORDER
  Call FlintLayoutButtons
FunctionEnd

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
    StrCpy $FlintBarRef 0xEBE8E6
    StrCpy $FlintTrackRef 0x2B2522
  ${Else}
    StrCpy $FlintBarRef 0x37291F
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

  File "/oname=$PLUGINSDIR\flint\inter-regular.ttf" "${FLINT_INTER}\Inter_18pt-Regular.ttf"
  File "/oname=$PLUGINSDIR\flint\inter-medium.ttf" "${FLINT_INTER}\Inter_18pt-Medium.ttf"
  File "/oname=$PLUGINSDIR\flint\inter-semibold.ttf" "${FLINT_INTER}\Inter_18pt-SemiBold.ttf"
  System::Call 'gdi32::AddFontResourceExW(w "$PLUGINSDIR\flint\inter-regular.ttf", i 0x10, p 0)'
  System::Call 'gdi32::AddFontResourceExW(w "$PLUGINSDIR\flint\inter-medium.ttf", i 0x10, p 0)'
  System::Call 'gdi32::AddFontResourceExW(w "$PLUGINSDIR\flint\inter-semibold.ttf", i 0x10, p 0)'
  !insertmacro _FlintFont $FlintFontHero "Inter 18pt SemiBold" 600 31
  !insertmacro _FlintFont $FlintFontTitle "Inter 18pt SemiBold" 600 20
  !insertmacro _FlintFont $FlintFontBody "Inter 18pt" 400 13
  !insertmacro _FlintFont $FlintFontMedium "Inter 18pt Medium" 500 13
  !insertmacro _FlintFont $FlintFontSmall "Inter 18pt" 400 12

  System::Call 'kernel32::GetModuleHandleW(p 0) p .r0'
  ${FlintPx} $1 48
  System::Call 'user32::LoadImageW(p r0, p 103, i 1, i r1, i r1, i 0) p .r0'
  StrCpy $FlintIcon $0
  SendMessage $HWNDPARENT ${WM_SETICON} 0 $FlintIcon
  SendMessage $HWNDPARENT ${WM_SETICON} 1 $FlintIcon

  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i $FlintDark, i 4)'
  ${If} $FlintDark = 1
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i 0x0D0B0A, i 4)'
  ${Else}
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i 0xF8F8F8, i 4)'
  ${EndIf}

  !insertmacro _FlintHide $HWNDPARENT 1028
  !insertmacro _FlintHide $HWNDPARENT 1034
  !insertmacro _FlintHide $HWNDPARENT 1035
  !insertmacro _FlintHide $HWNDPARENT 1036
  !insertmacro _FlintHide $HWNDPARENT 1037
  !insertmacro _FlintHide $HWNDPARENT 1038
  !insertmacro _FlintHide $HWNDPARENT 1039
  !insertmacro _FlintHide $HWNDPARENT 1045
  !insertmacro _FlintHide $HWNDPARENT 1256

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
  !insertmacro _FlintCtl $HWNDPARENT NONE BG

  !if "${UN}" == ""
    IfSilent flint_keep_passive
    StrCpy $PassiveMode 0
    ClearErrors
    ${GetOptions} $CMDLINE "/P" $0
    ${IfNot} ${Errors}
      StrCpy $PassiveMode 1
    ${EndIf}
  flint_keep_passive:
  !endif
FunctionEnd

!if "${UN}" == "un."
Function un.onGUIEnd
!else
Function .onGUIEnd
!endif
  System::Call 'gdi32::DeleteObject(p $FlintFontHero)'
  System::Call 'gdi32::DeleteObject(p $FlintFontTitle)'
  System::Call 'gdi32::DeleteObject(p $FlintFontBody)'
  System::Call 'gdi32::DeleteObject(p $FlintFontMedium)'
  System::Call 'gdi32::DeleteObject(p $FlintFontSmall)'
  System::Call 'user32::DestroyIcon(p $FlintIcon)'
  System::Call 'gdi32::RemoveFontResourceExW(w "$PLUGINSDIR\flint\inter-regular.ttf", i 0x10, p 0)'
  System::Call 'gdi32::RemoveFontResourceExW(w "$PLUGINSDIR\flint\inter-medium.ttf", i 0x10, p 0)'
  System::Call 'gdi32::RemoveFontResourceExW(w "$PLUGINSDIR\flint\inter-semibold.ttf", i 0x10, p 0)'
FunctionEnd
!macroend

Function FlintPageIcon
  ${FlintPx} $0 ${FLINT_PAD}
  ${FlintPx} $1 ${FLINT_PAD}
  ${FlintPx} $2 52
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", p 0, i 0x50000003, i r0, i r1, i r2, i r2, p $R2, p 0, p 0, p 0) p .r3'
  SendMessage $3 ${STM_SETIMAGE} ${IMAGE_ICON} $FlintIcon
  !insertmacro _FlintCtl $3 NONE BG
FunctionEnd

Function FlintWelcome
  ${IfThen} $PassiveMode = 1 ${|} Abort ${|}
  nsDialogs::Create 1018
  Pop $R2
  ${If} $R2 == error
    Abort
  ${EndIf}
  !insertmacro _FlintFitPage $R2
  Call FlintPageIcon

  !insertmacro _FlintLabel $4 $R2 116 42 580 42 "Install ${PRODUCTNAME}" $FlintFontHero FG
  !insertmacro _FlintLabel $4 $R2 116 91 580 28 "Your local AI workspace, ready in minutes." $FlintFontTitle MUTED
  !insertmacro _FlintLabel $4 $R2 116 142 580 52 "${PRODUCTNAME} runs locally on your computer, giving you a private space for chats, coding and agent workflows with the models you choose." $FlintFontBody FG2
  !insertmacro _FlintLabel $4 $R2 116 224 240 22 "Private by default" $FlintFontMedium FG
  !insertmacro _FlintLabel $4 $R2 116 248 500 20 "Your data stays on your machine." $FlintFontSmall MUTED
  !insertmacro _FlintLabel $4 $R2 116 286 240 22 "Local-first" $FlintFontMedium FG
  !insertmacro _FlintLabel $4 $R2 116 310 500 20 "Fast, controllable and built around your own models." $FlintFontSmall MUTED
  !insertmacro _FlintLabel $4 $R2 116 348 260 22 "Bring your own models" $FlintFontMedium FG
  !insertmacro _FlintLabel $4 $R2 116 372 500 20 "Use local engines or the providers you already trust." $FlintFontSmall MUTED

  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Continue"
  GetDlgItem $0 $HWNDPARENT 2
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Cancel"
  Call FlintShowFooter
  nsDialogs::Show
FunctionEnd

Function FlintWelcomeLeave
FunctionEnd

Function FlintOptions
  ${IfThen} $PassiveMode = 1 ${|} Abort ${|}
  nsDialogs::Create 1018
  Pop $R2
  ${If} $R2 == error
    Abort
  ${EndIf}
  !insertmacro _FlintFitPage $R2

  !insertmacro _FlintLabel $4 $R2 36 34 680 40 "Choose installation options" $FlintFontHero FG
  !insertmacro _FlintLabel $4 $R2 36 80 680 26 "Pick where Flint should be installed and how it should be set up." $FlintFontBody MUTED
  !insertmacro _FlintLabel $4 $R2 36 132 280 22 "Install location" $FlintFontMedium FG

  ${FlintPx} $0 36
  ${FlintPx} $1 162
  ${FlintPx} $2 570
  ${FlintPx} $3 30
  ${NSD_CreateText} $0 $1 $2 $3 "$INSTDIR"
  Pop $FlintInstallDir
  SendMessage $FlintInstallDir ${WM_SETFONT} $FlintFontBody 1

  ${FlintPx} $0 616
  ${FlintPx} $1 162
  ${FlintPx} $2 108
  ${FlintPx} $3 30
  ${NSD_CreateBrowseButton} $0 $1 $2 $3 "Browse"
  Pop $4
  SendMessage $4 ${WM_SETFONT} $FlintFontMedium 1
  ${NSD_OnClick} $4 FlintBrowseInstallDir

  !insertmacro _FlintLabel $4 $R2 36 222 280 22 "Options" $FlintFontMedium FG
  ${FlintPx} $0 36
  ${FlintPx} $1 254
  ${FlintPx} $2 420
  ${FlintPx} $3 20
  ${NSD_CreateCheckbox} $0 $1 $2 $3 "Create desktop shortcut"
  Pop $FlintDesktopShortcut
  SendMessage $FlintDesktopShortcut ${WM_SETFONT} $FlintFontBody 1
  ${NSD_Check} $FlintDesktopShortcut

  ${FlintPx} $0 36
  ${FlintPx} $1 286
  ${FlintPx} $2 420
  ${FlintPx} $3 20
  ${NSD_CreateCheckbox} $0 $1 $2 $3 "Launch Flint after setup"
  Pop $FlintLaunchAfter
  SendMessage $FlintLaunchAfter ${WM_SETFONT} $FlintFontBody 1
  ${NSD_Check} $FlintLaunchAfter

  !insertmacro _FlintLabel $4 $R2 36 344 650 38 "Flint installs for your Windows account. Models and app data stay separate from the program files." $FlintFontSmall MUTED

  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_SHOW}
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Back"
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_SHOW}
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Cancel"
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Install Flint"
  Call FlintShowFooter
  nsDialogs::Show
FunctionEnd

Function FlintBrowseInstallDir
  Pop $0
  ${NSD_GetText} $FlintInstallDir $1
  nsDialogs::SelectFolderDialog "Choose where Flint should be installed" "$1"
  Pop $2
  ${If} $2 != error
  ${AndIf} $2 != ""
    ${NSD_SetText} $FlintInstallDir "$2"
  ${EndIf}
FunctionEnd

Function FlintOptionsLeave
  ${NSD_GetText} $FlintInstallDir $INSTDIR
  ${NSD_GetState} $FlintDesktopShortcut $0
  ${If} $0 = ${BST_CHECKED}
    StrCpy $NoShortcutMode 0
  ${Else}
    StrCpy $NoShortcutMode 1
  ${EndIf}
  ${NSD_GetState} $FlintLaunchAfter $FlintFinishLaunch
FunctionEnd

Function FlintFinish
  ${IfThen} $PassiveMode = 1 ${|} Abort ${|}
  ${If} $NoShortcutMode <> 1
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}

  nsDialogs::Create 1018
  Pop $R2
  ${If} $R2 == error
    Abort
  ${EndIf}
  !insertmacro _FlintFitPage $R2
  Call FlintPageIcon

  !insertmacro _FlintLabel $4 $R2 116 42 580 42 "Flint is ready" $FlintFontHero FG
  !insertmacro _FlintLabel $4 $R2 116 91 580 28 "Setup is complete. Flint has been installed successfully." $FlintFontTitle MUTED
  !insertmacro _FlintLabel $4 $R2 116 158 160 22 "Installed to" $FlintFontMedium FG
  !insertmacro _FlintLabel $4 $R2 116 184 560 24 "$INSTDIR" $FlintFontBody MUTED
  !insertmacro _FlintLabel $4 $R2 116 232 160 22 "Version" $FlintFontMedium FG
  !insertmacro _FlintLabel $4 $R2 116 258 220 24 "${VERSION}" $FlintFontBody MUTED
  !insertmacro _FlintLabel $4 $R2 116 306 160 22 "Status" $FlintFontMedium FG
  !insertmacro _FlintLabel $4 $R2 116 332 220 24 "Ready" $FlintFontBody FG

  ${FlintPx} $0 116
  ${FlintPx} $1 376
  ${FlintPx} $2 360
  ${FlintPx} $3 20
  ${NSD_CreateCheckbox} $0 $1 $2 $3 "Launch Flint now"
  Pop $FlintLaunchAfter
  SendMessage $FlintLaunchAfter ${WM_SETFONT} $FlintFontBody 1
  ${If} $FlintFinishLaunch = ${BST_CHECKED}
    ${NSD_Check} $FlintLaunchAfter
  ${EndIf}

  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_SHOW}
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Finish"
  Call FlintShowFooter
  nsDialogs::Show
FunctionEnd

Function FlintFinishLeave
  ${NSD_GetState} $FlintLaunchAfter $0
  ${If} $0 = ${BST_CHECKED}
    nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
  ${EndIf}
FunctionEnd

!macroundef MUI_PAGE_WELCOME
!macro MUI_PAGE_WELCOME
  !ifdef MUI_PAGE_CUSTOMFUNCTION_PRE
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !endif
  Page custom FlintWelcome FlintWelcomeLeave
!macroend

!macroundef MUI_PAGE_DIRECTORY
!macro MUI_PAGE_DIRECTORY
  !ifdef MUI_PAGE_CUSTOMFUNCTION_PRE
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !endif
  Page custom FlintOptions FlintOptionsLeave
!macroend

!macroundef MUI_PAGE_FINISH
!macro MUI_PAGE_FINISH
  !ifdef MUI_PAGE_CUSTOMFUNCTION_PRE
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !endif
  Page custom FlintFinish FlintFinishLeave
!macroend

!macro FLINT_PROGRESS_FUNCTIONS UN
Function ${UN}FlintHeader
  ${FlintPx} $0 ${FLINT_PAD}
  ${FlintPx} $1 42
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", p 0, i 0x50000003, i r0, i r0, i r1, i r1, p R2, p 0, p 0, p 0) p .r2'
  SendMessage $2 ${STM_SETIMAGE} ${IMAGE_ICON} $FlintIcon
  !insertmacro _FlintCtl $2 NONE BG

  ${FlintPx} $1 94
  ${FlintPx} $3 650
  ${FlintPx} $4 34
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w R3, i 0x50000000, i r0, i r1, i r3, i r4, p R2, p 0, p 0, p 0) p .r2'
  StrCpy $FlintTitle $2
  SendMessage $2 ${WM_SETFONT} $FlintFontHero 1
  !insertmacro _FlintCtl $2 FG BG

  ${FlintPx} $1 137
  ${FlintPx} $4 42
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w R4, i 0x50000000, i r0, i r1, i r3, i r4, p R2, p 0, p 0, p 0) p .r2'
  StrCpy $FlintSubtitle $2
  SendMessage $2 ${WM_SETFONT} $FlintFontBody 1
  !insertmacro _FlintCtl $2 MUTED BG
FunctionEnd

Function ${UN}FlintInstFilesShow
  FindWindow $R2 "#32770" "" $HWNDPARENT
  !insertmacro _FlintFitPage $R2
  !insertmacro _FlintHide $R2 1016
  !insertmacro _FlintHide $R2 1027

  !if "${UN}" == "un."
    StrCpy $R3 "Uninstalling ${PRODUCTNAME}"
    StrCpy $R4 "Removing Flint from this computer. Your data is kept unless you chose to remove it."
  !else
    StrCpy $R3 "Installing ${PRODUCTNAME}"
    StrCpy $R4 "Setting up your local AI workspace. This should only take a moment."
  !endif
  Call ${UN}FlintHeader

  ${FlintPx} $1 ${FLINT_PAD}
  ${FlintPx} $3 688
  GetDlgItem $0 $R2 1006
  ${FlintPx} $2 304
  ${FlintPx} $4 20
  System::Call 'user32::SetWindowPos(p r0, p 0, i r1, i r2, i r3, i r4, i 0x14)'
  SendMessage $0 ${WM_SETFONT} $FlintFontSmall 1
  !insertmacro _FlintCtl $0 MUTED BG

  GetDlgItem $0 $R2 1004
  System::Call 'uxtheme::SetWindowTheme(p r0, w " ", w " ")'
  System::Call 'user32::GetWindowLongW(p r0, i -16) i .r5'
  IntOp $5 $5 & 0xFF7FFFFF
  System::Call 'user32::SetWindowLongW(p r0, i -16, i r5)'
  ${FlintPx} $2 276
  ${FlintPx} $4 7
  System::Call 'user32::SetWindowPos(p r0, p 0, i r1, i r2, i r3, i r4, i 0x34)'
  SendMessage $0 0x409 0 $FlintBarRef
  SendMessage $0 0x2001 0 $FlintTrackRef

  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_SHOW}
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Cancel"
  Call FlintShowFooter
FunctionEnd

Function ${UN}FlintRestoreButtons
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_SHOW}
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Close"
  Call FlintLayoutButtons
FunctionEnd

Function ${UN}FlintInstFilesLeave
  IfAbort 0 flint_done_${UN}
    !if "${UN}" == "un."
      SendMessage $FlintTitle ${WM_SETTEXT} 0 "STR:Couldn't uninstall ${PRODUCTNAME}"
    !else
      SendMessage $FlintTitle ${WM_SETTEXT} 0 "STR:Couldn't install ${PRODUCTNAME}"
    !endif
    SendMessage $FlintSubtitle ${WM_SETTEXT} 0 "STR:The reason is shown below. Close this window and try again."
    FindWindow $0 "#32770" "" $HWNDPARENT
    !insertmacro _FlintHide $0 1004
    Call ${UN}FlintRestoreButtons
  flint_done_${UN}:
FunctionEnd
!macroend

!insertmacro FLINT_PROGRESS_FUNCTIONS ""
!insertmacro FLINT_PROGRESS_FUNCTIONS "un."

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
  StrCpy $R4 "Flint will be removed from this computer. Your chats, models and settings are kept unless you turn on the option below."
  Call un.FlintHeader

  ${FlintPx} $0 ${FLINT_PAD}
  ${FlintPx} $1 224
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

  ${FlintPx} $0 76
  ${FlintPx} $1 223
  ${FlintPx} $2 620
  ${FlintPx} $3 20
  ${NSD_CreateLabel} $0 $1 $2 $3 "$(deleteAppData)"
  Pop $4
  SendMessage $4 ${WM_SETFONT} $FlintFontBody 1
  !insertmacro _FlintCtl $4 FG2 BG
  ${NSD_OnClick} $4 un.FlintToggleClick

  ${FlintPx} $1 326
  ${FlintPx} $2 ${FLINT_W}
  ${FlintPx} $3 1
  ${NSD_CreateLabel} 0 $1 $2 $3 ""
  Pop $4
  !insertmacro _FlintCtl $4 NONE BORDER

  ${FlintPx} $1 348
  ${FlintPx} $2 88
  ${FlintPx} $3 36
  ${FlintPx} $0 636
  ${NSD_CreateBitmap} $0 $1 $2 $3 ""
  Pop $4
  ${NSD_SetImage} $4 "$FlintAssets\btn-uninstall.bmp" $FlintBtnImgA
  ${NSD_OnClick} $4 un.FlintNext
  ${FlintPx} $0 540
  ${NSD_CreateBitmap} $0 $1 $2 $3 ""
  Pop $4
  ${NSD_SetImage} $4 "$FlintAssets\btn-cancel.bmp" $FlintBtnImgB
  ${NSD_OnClick} $4 un.FlintCancel

  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}

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
