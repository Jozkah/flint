!macro FLINT_UNINSTALL_CONFIRM_PAGE stateVar
UninstPage custom un.FlintConfirm un.FlintConfirmLeave
Function un.FlintConfirm
  ${IfThen} $PassiveMode = 1 ${|} Abort ${|}
  nsDialogs::Create 1018
  Pop $FlintPage
  ${If} $FlintPage == error
    Abort
  ${EndIf}
  StrCpy $R3 "Uninstall Flint"
  StrCpy $R4 "Remove Flint from this computer. Your data is kept unless you choose otherwise."
  Call un.FlintShell

  ${FlintPx} $0 ${FLINT_RIGHT_X}
  ${FlintPx} $1 170
  ${FlintPx} $2 30
  ${FlintPx} $3 18
  ${NSD_CreateBitmap} $0 $1 $2 $3 ""
  Pop $FlintDeleteSwitch
  ${If} ${stateVar} = 1
    ${NSD_SetImage} $FlintDeleteSwitch "$FlintAssets\switch-on.bmp" $FlintDeleteSwitchImg
  ${Else}
    ${NSD_SetImage} $FlintDeleteSwitch "$FlintAssets\switch-off.bmp" $FlintDeleteSwitchImg
  ${EndIf}
  ${NSD_OnClick} $FlintDeleteSwitch un.FlintToggleDelete

  ${FlintPx} $0 310
  ${FlintPx} $1 168
  ${FlintPx} $2 350
  ${FlintPx} $3 24
  ${NSD_CreateLabel} $0 $1 $2 $3 "Also delete chats, models and settings"
  Pop $4
  SendMessage $4 ${WM_SETFONT} $FlintFontBody 1
  !insertmacro _FlintCtl $4 FG2 BG

  ${FlintPx} $0 ${FLINT_RIGHT_X}
  ${FlintPx} $1 224
  ${FlintPx} $2 ${FLINT_RIGHT_W}
  ${FlintPx} $3 54
  ${NSD_CreateLabel} $0 $1 $2 $3 "Leaving this off removes only the application. Turn it on only if you also want Flint's local data removed."
  Pop $4
  SendMessage $4 ${WM_SETFONT} $FlintFontSmall 1
  !insertmacro _FlintCtl $4 MUTED BG

  ; Keep the existing, pre-rendered destructive and cancel controls. Their
  ; labels are already rendered with the app's Inter/button tokens.
  ${FlintPx} $0 456
  ${FlintPx} $1 368
  ${FlintPx} $2 88
  ${FlintPx} $3 36
  ${NSD_CreateBitmap} $0 $1 $2 $3 ""
  Pop $4
  ${NSD_SetImage} $4 "$FlintAssets\btn-cancel.bmp" $5
  ${NSD_OnClick} $4 un.FlintCancel
  ${FlintPx} $0 556
  ${NSD_CreateBitmap} $0 $1 $2 $3 ""
  Pop $4
  ${NSD_SetImage} $4 "$FlintAssets\btn-uninstall.bmp" $6
  ${NSD_OnClick} $4 un.FlintNext

  nsDialogs::Show
  ${NSD_FreeImage} $FlintDeleteSwitchImg
FunctionEnd

Function un.FlintToggleDelete
  Pop $0
  ${NSD_FreeImage} $FlintDeleteSwitchImg
  ${If} ${stateVar} = 1
    StrCpy ${stateVar} 0
    ${NSD_SetImage} $FlintDeleteSwitch "$FlintAssets\switch-off.bmp" $FlintDeleteSwitchImg
  ${Else}
    StrCpy ${stateVar} 1
    ${NSD_SetImage} $FlintDeleteSwitch "$FlintAssets\switch-on.bmp" $FlintDeleteSwitchImg
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
FunctionEnd
!macroend

!macro FLINT_UNINSTALL_FINISH_PAGE
UninstPage custom un.FlintFinish
Function un.FlintFinish
  ${IfThen} $PassiveMode = 1 ${|} Abort ${|}
  nsDialogs::Create 1018
  Pop $FlintPage
  ${If} $FlintPage == error
    Abort
  ${EndIf}
  StrCpy $R3 "Flint was removed"
  StrCpy $R4 "Uninstallation completed successfully."
  Call un.FlintShell

  ${FlintPx} $0 ${FLINT_RIGHT_X}
  ${FlintPx} $1 176
  ${FlintPx} $2 ${FLINT_RIGHT_W}
  ${FlintPx} $3 56
  ${NSD_CreateLabel} $0 $1 $2 $3 "The Flint application has been removed from this computer."
  Pop $4
  SendMessage $4 ${WM_SETFONT} $FlintFontBody 1
  !insertmacro _FlintCtl $4 FG2 BG

  !insertmacro _FlintPrimaryButton 556 366 "Close" un.FlintFinishClose
  nsDialogs::Show
FunctionEnd
Function un.FlintFinishClose
  Pop $0
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
FunctionEnd
!macroend
