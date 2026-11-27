!macrohook NSIS_HOOK_PREINSTALL
  ; Ensure running AI Proxy instances are closed cleanly before overwriting files during upgrade
  nsExec::ExecToLog 'taskkill /F /IM "AI Proxy.exe" /T'
  Sleep 450
!macroend
