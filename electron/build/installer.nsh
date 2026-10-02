; Included by the NSIS installer (electron-builder.config.cjs, nsis.include).
;
; electron-builder's `protocols` option only writes the macOS Info.plist, so the Windows installer
; registers dsul:// itself. Per user (HKCU), to match perMachine: false. The command is quoted
; with "%1" last and never %*, so a link arrives as exactly one argument (main.cjs reads exactly
; one dsul: entry from argv and ignores the rest).

!macro customInstall
  WriteRegStr HKCU "Software\Classes\dsul" "" "URL:dsul"
  WriteRegStr HKCU "Software\Classes\dsul" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\dsul\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

; An update runs the old uninstaller first; keeping the key through it means sign-in links never
; find it missing mid-update. customInstall rewrites it straight after.
;
; Open at login (main.cjs setLoginItem) is a Run value named after the app id, plus the
; StartupApproved twin Task Manager writes when it is switched off there. Nothing else removes
; them, and a Run value left behind lists a dsul that no longer exists under Startup apps (and
; ticks the box again on a reinstall). An update must keep them: unlike the dsul key, nothing
; writes them back afterwards, so deleting them here would switch Open at login off every update.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\dsul"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${APP_ID}"
  ${endIf}
!macroend
