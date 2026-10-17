!macro medclawGuard MODE ROOT
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\medclaw-check"
  File /oname=bun.exe "${PROJECT_DIR}\.build\package-resources\medclaw\bin\bun.exe"
  File /oname=installer-check.js "${PROJECT_DIR}\.build\package-resources\medclaw\installer-check.js"
  nsExec::ExecToStack /TIMEOUT=30000 '"$PLUGINSDIR\medclaw-check\bun.exe" --no-env-file "$PLUGINSDIR\medclaw-check\installer-check.js" "${ROOT}" "${MODE}"'
  Pop $R1
  Pop $R2
  ${If} $R1 != 0
    MessageBox MB_OK|MB_ICONSTOP "MedClaw execution has not been confirmed stopped. Exit MedClaw and resolve Host recovery before retrying." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customHeader
  Var MedClawGuarded
!macroend

!macro customCheckAppRunning
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R1
  ${nsProcess::Unload}
  ${If} $R1 != 603
    MessageBox MB_OK|MB_ICONSTOP "Exit MedClaw before installing or uninstalling. The installer will not close the application." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  !ifdef BUILD_UNINSTALLER
    ${If} $MedClawGuarded != 1
      !insertmacro medclawGuard "--retain-parent" "$APPDATA\MedClaw"
      StrCpy $MedClawGuarded 1
    ${EndIf}
  !else
    ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${AndIfNot} ${FileExists} "$INSTDIR\resources\medclaw\installer-check.js"
      MessageBox MB_OK|MB_ICONSTOP "This installation does not support safe in-place replacement. Preserve its data and backup, then use a separate installation directory." /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
    !insertmacro medclawGuard "--check" "$APPDATA\MedClaw"
  !endif
!macroend

!macro customUnInstallCheck
  ${If} ${Errors}
  ${OrIf} $R0 != 0
    SetErrorLevel 2
    Quit
  ${EndIf}
  ; The old uninstaller guarded deletion; the installer now guards replacement.
  !insertmacro medclawGuard "--retain-parent" "$APPDATA\MedClaw"
  StrCpy $MedClawGuarded 1
!macroend
