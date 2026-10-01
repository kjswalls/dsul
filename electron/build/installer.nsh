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
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\dsul"
  ${endIf}
!macroend
