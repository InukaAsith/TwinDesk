; TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
; The Full KVM build's installer hooks (docs/full-kvm.md; installer/build.js uses this file instead of
; installer.nsh when TWINDESK_EDITION=full-kvm). The service runs from our files: it stops before
; they are replaced and starts again after; uninstalling (not an update) takes it away, with
; Ctrl+Alt+Del's policy put back and %ProgramData%\TwinDesk\machine wiped (twindesk-fullkvm.exe --apply off).

!macro fullKvmInit
  nsExec::Exec '"$INSTDIR\resources\app\windows\fullkvm\bin\twindesk-fullkvm.exe" --stop'
  nsExec::Exec 'taskkill /f /im macshare-winhelper-agent.exe'
!macroend

!macro fullKvmInstall
  nsExec::Exec '"$INSTDIR\resources\app\windows\fullkvm\bin\twindesk-fullkvm.exe" --start'
!macroend

!macro fullKvmUnInstall
  ${ifNot} ${isUpdated}
    nsExec::Exec '"$INSTDIR\resources\app\windows\fullkvm\bin\twindesk-fullkvm.exe" --apply off'
  ${else}
    nsExec::Exec '"$INSTDIR\resources\app\windows\fullkvm\bin\twindesk-fullkvm.exe" --stop'
    nsExec::Exec 'taskkill /f /im macshare-winhelper-agent.exe'
  ${endIf}
!macroend

!include "${__FILEDIR__}\installer.nsh" ; this folder's, not electron-builder's own installer.nsh on the include path
