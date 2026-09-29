Function FlintWelcome
  ${IfThen} $PassiveMode = 1 ${|} Abort ${|}
  nsDialogs::Create 1018
  Pop $FlintPage
  ${If} $FlintPage == error
    Abort
  ${EndIf}
  StrCpy $R3 "Install Flint"
  StrCpy $R4 "Your local AI workspace, ready in minutes."
  Call FlintShell

  ${FlintPx} $0 ${FLINT_RIGHT_X}
  ${FlintPx} $1 146
  ${FlintPx} $2 ${FLINT_RIGHT_W}
  ${FlintPx} $3 54
  ${NSD_CreateLabel} $0 $1 $2 $3 "Flint runs locally on your computer for chats, coding and agent workflows — with the models and providers you choose."
  Pop $4
  SendMessage $4 ${WM_SETFONT} $FlintFontBody 1
  !insertmacro _FlintCtl $4 FG2 BG

  ${FlintPx} $1 224
  ${FlintPx} $3 22
  ${NSD_CreateLabel} $0 $1 $2 $3 "●   Private by default"
  Pop $4
  SendMessage $4 ${WM_SETFONT} $FlintFontBodyMedium 1
  !insertmacro _FlintCtl $4 FG BG
  ${FlintPx} $1 250
  ${NSD_CreateLabel} $0 $1 $2 $3 "●   Local-first and under your control"
  Pop $4
  SendMessage $4 ${WM_SETFONT} $FlintFontBodyMedium 1
  !insertmacro _FlintCtl $4 FG BG
  ${FlintPx} $1 276
  ${NSD_CreateLabel} $0 $1 $2 $3 "●   Bring your own models"
  Pop $4
  SendMessage $4 ${WM_SETFONT} $FlintFontBodyMedium 1
  !insertmacro _FlintCtl $4 FG BG

  !insertmacro _FlintSecondaryButton 412 366 "Cancel" FlintCancel
  !insertmacro _FlintPrimaryButton 556 366 "Continue" FlintNext
  nsDialogs::Show
FunctionEnd

Function FlintWelcomeLeave
FunctionEnd

Function FlintBrowse
  Pop $0
  nsDialogs::SelectFolderDialog "Choose where Flint should be installed" "$INSTDIR"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $FlintPathEdit $0
  ${EndIf}
FunctionEnd

Function FlintToggleDesktop
  Pop $0
  ${NSD_FreeImage} $FlintDesktopSwitchImg
  ${If} $FlintDesktopShortcutState = 1
    StrCpy $FlintDesktopShortcutState 0
    ${NSD_SetImage} $FlintDesktopSwitch "$FlintAssets\switch-off.bmp" $FlintDesktopSwitchImg
  ${Else}
    StrCpy $FlintDesktopShortcutState 1
    ${NSD_SetImage} $FlintDesktopSwitch "$FlintAssets\switch-on.bmp" $FlintDesktopSwitchImg
  ${EndIf}
FunctionEnd

Function FlintToggleLaunch
  Pop $0
  ${NSD_FreeImage} $FlintLaunchSwitchImg
  ${If} $FlintLaunchState = 1
    StrCpy $FlintLaunchState 0
    ${NSD_SetImage} $FlintLaunchSwitch "$FlintAssets\switch-off.bmp" $FlintLaunchSwitchImg
  ${Else}
    StrCpy $FlintLaunchState 1
    ${NSD_SetImage} $FlintLaunchSwitch "$FlintAssets\switch-on.bmp" $FlintLaunchSwitchImg
  ${EndIf}
FunctionEnd

Function FlintOptions
  ${IfThen} $PassiveMode = 1 ${|} Abort ${|}
  nsDialogs::Create 1018
  Pop $FlintPage
  ${If} $FlintPage == error
    Abort
  ${EndIf}
  StrCpy $R3 "Choose installation options"
  StrCpy $R4 "Pick where Flint should live and how setup should finish."
  Call FlintShell

  ${FlintPx} $0 ${FLINT_RIGHT_X}
  ${FlintPx} $1 148
  ${FlintPx} $2 424
  ${FlintPx} $3 20
  ${NSD_CreateLabel} $0 $1 $2 $3 "Install location"
  Pop $4
  SendMessage $4 ${WM_SETFONT} $FlintFontBodyMedium 1
  !insertmacro _FlintCtl $4 FG BG

  ${FlintPx} $1 176
  ${FlintPx} $2 280
  ${FlintPx} $3 36
  ${NSD_CreateText} $0 $1 $2 $3 "$INSTDIR"
  Pop $FlintPathEdit
  SendMessage $FlintPathEdit ${WM_SETFONT} $FlintFontBody 1
  !insertmacro _FlintCtl $FlintPathEdit FG CARD

  !insertmacro _FlintSecondaryButton 556 174 "Browse" FlintBrowse

  ${FlintPx} $0 ${FLINT_RIGHT_X}
  ${FlintPx} $1 236
  ${FlintPx} $2 30
  ${FlintPx} $3 18
  ${NSD_CreateBitmap} $0 $1 $2 $3 ""
  Pop $FlintDesktopSwitch
  ${If} $FlintDesktopShortcutState = 1
    ${NSD_SetImage} $FlintDesktopSwitch "$FlintAssets\switch-on.bmp" $FlintDesktopSwitchImg
  ${Else}
    ${NSD_SetImage} $FlintDesktopSwitch "$FlintAssets\switch-off.bmp" $FlintDesktopSwitchImg
  ${EndIf}
  ${NSD_OnClick} $FlintDesktopSwitch FlintToggleDesktop
  ${FlintPx} $0 310
  ${FlintPx} $1 234
  ${FlintPx} $2 350
  ${FlintPx} $3 24
  ${NSD_CreateLabel} $0 $1 $2 $3 "Create a desktop shortcut"
  Pop $4
  SendMessage $4 ${WM_SETFONT} $FlintFontBody 1
  !insertmacro _FlintCtl $4 FG2 BG

  ${FlintPx} $0 ${FLINT_RIGHT_X}
  ${FlintPx} $1 278
  ${FlintPx} $2 30
  ${FlintPx} $3 18
  ${NSD_CreateBitmap} $0 $1 $2 $3 ""
  Pop $FlintLaunchSwitch
  ${If} $FlintLaunchState = 1
    ${NSD_SetImage} $FlintLaunchSwitch "$FlintAssets\switch-on.bmp" $FlintLaunchSwitchImg
  ${Else}
    ${NSD_SetImage} $FlintLaunchSwitch "$FlintAssets\switch-off.bmp" $FlintLaunchSwitchImg
  ${EndIf}
  ${NSD_OnClick} $FlintLaunchSwitch FlintToggleLaunch
  ${FlintPx} $0 310
  ${FlintPx} $1 276
  ${FlintPx} $2 350
  ${FlintPx} $3 24
  ${NSD_CreateLabel} $0 $1 $2 $3 "Launch Flint when setup finishes"
  Pop $4
  SendMessage $4 ${WM_SETFONT} $FlintFontBody 1
  !insertmacro _FlintCtl $4 FG2 BG

  ${FlintPx} $0 ${FLINT_RIGHT_X}
  ${FlintPx} $1 320
  ${FlintPx} $2 ${FLINT_RIGHT_W}
  ${FlintPx} $3 34
  ${NSD_CreateLabel} $0 $1 $2 $3 "The bundled local runtime and tools are installed with Flint; setup may also install required Windows runtimes."
  Pop $4
  SendMessage $4 ${WM_SETFONT} $FlintFontTiny 1
  !insertmacro _FlintCtl $4 MUTED BG

  !insertmacro _FlintSecondaryButton 268 366 "Back" FlintBack
  !insertmacro _FlintSecondaryButton 412 366 "Cancel" FlintCancel
  !insertmacro _FlintPrimaryButton 556 366 "Install" FlintNext
  nsDialogs::Show
  ${NSD_FreeImage} $FlintDesktopSwitchImg
  ${NSD_FreeImage} $FlintLaunchSwitchImg
FunctionEnd

Function FlintOptionsLeave
  ${NSD_GetText} $FlintPathEdit $0
  ${If} $0 == ""
    MessageBox MB_ICONEXCLAMATION "Choose an install location before continuing."
    Abort
  ${EndIf}
  GetFullPathName $INSTDIR $0
FunctionEnd

; Existing-install page. The template computes the maintenance text and puts it
; in $R1/$R2/$R3 before calling this renderer.
Function FlintMaintenance
  StrCpy $7 $R1
  StrCpy $5 $R2
  StrCpy $6 $R3
  nsDialogs::Create 1018
  Pop $FlintPage
  ${If} $FlintPage == error
    Abort
  ${EndIf}
  StrCpy $R3 "Flint is already installed"
  StrCpy $R4 "Choose how setup should continue with the existing installation."
  Call FlintShell

  ${FlintPx} $0 ${FLINT_RIGHT_X}
  ${FlintPx} $1 148
  ${FlintPx} $2 ${FLINT_RIGHT_W}
  ${FlintPx} $3 50
  ${NSD_CreateLabel} $0 $1 $2 $3 "$7"
  Pop $4
  SendMessage $4 ${WM_SETFONT} $FlintFontBody 1
  !insertmacro _FlintCtl $4 FG2 BG

  ${FlintPx} $0 284
  ${FlintPx} $1 224
  ${FlintPx} $2 380
  ${FlintPx} $3 24
  ${NSD_CreateRadioButton} $0 $1 $2 $3 "$5"
  Pop $R2
  SendMessage $R2 ${WM_SETFONT} $FlintFontBody 1
  !insertmacro _FlintCtl $R2 FG BG
  ${NSD_OnClick} $R2 PageReinstallUpdateSelection

  ${FlintPx} $1 264
  ${NSD_CreateRadioButton} $0 $1 $2 $3 "$6"
  Pop $R3
  SendMessage $R3 ${WM_SETFONT} $FlintFontBody 1
  !insertmacro _FlintCtl $R3 FG BG
  !if "${ALLOWDOWNGRADES}" == "false"
    ${IfThen} $R0 = -1 ${|} EnableWindow $R3 0 ${|}
  !endif
  ${NSD_OnClick} $R3 PageReinstallUpdateSelection

  ${If} $ReinstallPageCheck <> 2
    SendMessage $R2 ${BM_SETCHECK} ${BST_CHECKED} 0
  ${Else}
    SendMessage $R3 ${BM_SETCHECK} ${BST_CHECKED} 0
  ${EndIf}

  !insertmacro _FlintSecondaryButton 412 366 "Cancel" FlintCancel
  !insertmacro _FlintPrimaryButton 556 366 "Continue" FlintNext
  nsDialogs::Show
FunctionEnd

; MUI installation/uninstallation progress functions are instantiated once for
; the installer and once with the `un.` prefix by FLINT_UI_FUNCTIONS.
!macro FLINT_PROGRESS_FUNCTIONS UN
Function ${UN}FlintInstFilesShow
  FindWindow $FlintPage "#32770" "" $HWNDPARENT
  !insertmacro _FlintFitPage $FlintPage
  !insertmacro _FlintHide $FlintPage 1016
  !insertmacro _FlintHide $FlintPage 1027

  !if "${UN}" == "un."
    StrCpy $R3 "Uninstalling Flint"
    StrCpy $R4 "Removing Flint from this computer."
  !else
    StrCpy $R3 "Installing Flint"
    StrCpy $R4 "Setting up your local AI workspace. This should only take a moment."
  !endif
  Call ${UN}FlintShell

  GetDlgItem $0 $FlintPage 1006
  ${FlintPx} $1 ${FLINT_RIGHT_X}
  ${FlintPx} $2 218
  ${FlintPx} $3 ${FLINT_RIGHT_W}
  ${FlintPx} $4 24
  System::Call 'user32::SetWindowPos(p r0, p 0, i r1, i r2, i r3, i r4, i 0x14)'
  SendMessage $0 ${WM_SETFONT} $FlintFontBodyMedium 1
  !insertmacro _FlintCtl $0 FG2 BG

  GetDlgItem $0 $FlintPage 1004
  System::Call 'uxtheme::SetWindowTheme(p r0, w " ", w " ")'
  System::Call 'user32::GetWindowLongW(p r0, i -16) i .r5'
  IntOp $5 $5 & 0xFF7FFFFF
  System::Call 'user32::SetWindowLongW(p r0, i -16, i r5)'
  System::Call 'user32::GetWindowLongW(p r0, i -20) i .r5'
  IntOp $5 $5 & 0xFFFDFDFF
  System::Call 'user32::SetWindowLongW(p r0, i -20, i r5)'
  ${FlintPx} $2 260
  ${FlintPx} $4 8
  System::Call 'user32::SetWindowPos(p r0, p 0, i r1, i r2, i r3, i r4, i 0x34)'
  SendMessage $0 0x409 0 $FlintBarRef
  SendMessage $0 0x2001 0 $FlintTrackRef

  ${FlintPx} $0 ${FLINT_RIGHT_X}
  ${FlintPx} $1 300
  ${FlintPx} $2 ${FLINT_RIGHT_W}
  ${FlintPx} $3 32
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "Flint is copying its application files and configuring required components.", i 0x50000000, i r0, i r1, i r2, i r3, p $FlintPage, p 0, p 0, p 0) p .r4'
  SendMessage $4 ${WM_SETFONT} $FlintFontTiny 1
  !insertmacro _FlintCtl $4 MUTED BG
FunctionEnd

Function ${UN}FlintRestoreButtons
  ${FlintPx} $6 ${FLINT_W}
  ${FlintPx} $7 ${FLINT_H}
  ${FlintPx} $5 14
  !insertmacro _FlintPlaceButton 2
  FindWindow $0 "#32770" "" $HWNDPARENT
  System::Call 'user32::GetWindowLongW(p r0, i -16) i .r1'
  IntOp $1 $1 | 0x04000000
  System::Call 'user32::SetWindowLongW(p r0, i -16, i r1)'
  System::Call 'user32::InvalidateRect(p $HWNDPARENT, p 0, i 1)'
FunctionEnd

Function ${UN}FlintInstFilesLeave
  IfAbort 0 flint_done
    !if "${UN}" == "un."
      SendMessage $FlintTitle ${WM_SETTEXT} 0 "STR:Couldn't uninstall Flint"
    !else
      SendMessage $FlintTitle ${WM_SETTEXT} 0 "STR:Couldn't install Flint"
    !endif
    SendMessage $FlintSubtitle ${WM_SETTEXT} 0 "STR:The reason is shown above. Close this window and try again."
    FindWindow $0 "#32770" "" $HWNDPARENT
    !insertmacro _FlintHide $0 1004
    Call ${UN}FlintRestoreButtons
  flint_done:
FunctionEnd
!macroend

Function FlintFinish
  ${IfThen} $PassiveMode = 1 ${|} Abort ${|}
  nsDialogs::Create 1018
  Pop $FlintPage
  ${If} $FlintPage == error
    Abort
  ${EndIf}
  StrCpy $R3 "Flint is ready"
  StrCpy $R4 "Setup is complete. Flint has been installed successfully."
  Call FlintShell

  ${FlintPx} $0 ${FLINT_RIGHT_X}
  ${FlintPx} $1 156
  ${FlintPx} $2 ${FLINT_RIGHT_W}
  ${FlintPx} $3 24
  ${NSD_CreateLabel} $0 $1 $2 $3 "Installed to:"
  Pop $4
  SendMessage $4 ${WM_SETFONT} $FlintFontBodyMedium 1
  !insertmacro _FlintCtl $4 FG BG
  ${FlintPx} $1 182
  ${FlintPx} $3 36
  ${NSD_CreateLabel} $0 $1 $2 $3 "$INSTDIR"
  Pop $4
  SendMessage $4 ${WM_SETFONT} $FlintFontSmall 1
  !insertmacro _FlintCtl $4 MUTED BG

  ${FlintPx} $1 236
  ${FlintPx} $3 24
  ${NSD_CreateLabel} $0 $1 $2 $3 "Version ${VERSION}    •    Ready"
  Pop $4
  SendMessage $4 ${WM_SETFONT} $FlintFontBodyMedium 1
  !insertmacro _FlintCtl $4 SUCCESS BG

  ${FlintPx} $1 292
  ${FlintPx} $3 42
  ${NSD_CreateLabel} $0 $1 $2 $3 "You can add models, providers and finish any first-run setup after Flint opens."
  Pop $4
  SendMessage $4 ${WM_SETFONT} $FlintFontSmall 1
  !insertmacro _FlintCtl $4 MUTED BG

  !insertmacro _FlintSecondaryButton 412 366 "Close" FlintFinishClose
  !insertmacro _FlintPrimaryButton 556 366 "Launch Flint" FlintFinishLaunch
  nsDialogs::Show
FunctionEnd

Function FlintFinishLeave
FunctionEnd

Function FlintFinishClose
  Pop $0
  StrCpy $FlintLaunchState 0
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
FunctionEnd

Function FlintFinishLaunch
  Pop $0
  StrCpy $FlintLaunchState 1
  Call RunMainBinary
  StrCpy $FlintLaunchState 0
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
FunctionEnd

Function FlintNext
  Pop $0
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
FunctionEnd
Function FlintBack
  Pop $0
  SendMessage $HWNDPARENT ${WM_COMMAND} 3 0
FunctionEnd
Function FlintCancel
  Pop $0
  SendMessage $HWNDPARENT ${WM_COMMAND} 2 0
FunctionEnd

!macro FLINT_WELCOME_PAGE
Page custom FlintWelcome FlintWelcomeLeave
!macroend

!macro FLINT_OPTIONS_PAGE
Page custom FlintOptions FlintOptionsLeave
!macroend

!macro FLINT_FINISH_PAGE
Page custom FlintFinish FlintFinishLeave
!macroend
