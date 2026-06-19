; StudIQ NSIS hooks — runs during install / uninstall.
;
; The ExcelDNA XLL is registered in HKCU\Software\Microsoft\Office\16.0\Excel\Options
; by the running app at first launch (bridge.rs ensure_xll_registered), not by the
; installer itself, because the OPEN slot number must be discovered at runtime.
;
; The installer only cleans up on uninstall: it reads the slot name the app recorded
; and removes that registry entry so Excel no longer loads the XLL after uninstall.

!macro NSIS_HOOK_POSTINSTALL
  ; XLL registration is performed by the app on first launch — nothing to do here.
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Remove the XLL from Excel's auto-load list.
  ; The app recorded which OPEN slot it used in Software\StudIQ\ExcelAddinOpenSlot.
  ReadRegStr $0 HKCU "Software\StudIQ" "ExcelAddinOpenSlot"
  StrCmp "$0" "" studiq_xll_done
  DeleteRegValue HKCU "Software\Microsoft\Office\16.0\Excel\Options" "$0"
  studiq_xll_done:
  DeleteRegValue HKCU "Software\StudIQ" "ExcelAddinOpenSlot"
  DeleteRegKey /ifempty HKCU "Software\StudIQ"
!macroend
