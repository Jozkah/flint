Unicode true
ManifestDPIAware true
ManifestDPIAwareness PerMonitorV2

!include MUI2.nsh
!include FileFunc.nsh
!include x64.nsh
!include LogicLib.nsh

!define PRODUCTNAME "Flint"
!define VERSION "0.9.0"
!define ALLOWDOWNGRADES "true"
!ifndef FLINT_SMOKE_ROOT
  !define FLINT_SMOKE_ROOT ".."
!endif
!define FLINT_WORKSPACE "${FLINT_SMOKE_ROOT}"
!define MUI_ICON "${FLINT_SMOKE_ROOT}\src-tauri\icons\icon.ico"

Name "Flint Installer UI Smoke"
OutFile "flint-installer-ui-smoke.exe"
InstallDir "$TEMP\FlintInstallerSmoke"
RequestExecutionLevel user

Var PassiveMode
Var DeleteAppDataCheckboxState

!include "${FLINT_SMOKE_ROOT}\src-tauri\installer\windows\flint-ui.nsh"

!insertmacro FLINT_WELCOME_PAGE
!insertmacro FLINT_OPTIONS_PAGE
; Exercise the existing-install renderer too. The production template reaches
; this function from its reinstall/upgrade page; without a corresponding page
; in the smoke harness NSIS correctly reports it as dead code (warning 6010),
; which /WX then promotes to a CI failure.
Page custom FlintMaintenance
!define MUI_PAGE_CUSTOMFUNCTION_SHOW FlintInstFilesShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE FlintInstFilesLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro FLINT_FINISH_PAGE

!insertmacro FLINT_UNINSTALL_CONFIRM_PAGE $DeleteAppDataCheckboxState
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.FlintInstFilesShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.FlintInstFilesLeave
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro FLINT_UNINSTALL_FINISH_PAGE

!insertmacro FLINT_UI_FUNCTIONS ""
!insertmacro FLINT_UI_FUNCTIONS "un."
!insertmacro MUI_LANGUAGE "English"

Function RunMainBinary
FunctionEnd

Function PageReinstallUpdateSelection
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
