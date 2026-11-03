; Uninstall hooks for the NSIS installer.
;
; The inbox and the log live in %LOCALAPPDATA%\Pod: the installer never
; recorded them, so the default uninstaller would leave them behind.

!macro NSIS_HOOK_PREUNINSTALL
  RMDir /r "$LOCALAPPDATA\Pod\inbox"
  Delete "$LOCALAPPDATA\Pod\pod.log"
!macroend
