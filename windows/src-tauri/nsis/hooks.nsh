; Uninstall hooks for the NSIS installer.
;
; The inbox and the log live in %LOCALAPPDATA%\Pod: the installer never
; recorded them, so the default uninstaller would leave them behind. An update
; (/UPDATE, what Pod's updater passes) is not an uninstall: they stay.

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    RMDir /r "$LOCALAPPDATA\Pod\inbox"
    Delete "$LOCALAPPDATA\Pod\pod.log"
  ${EndIf}
!macroend
