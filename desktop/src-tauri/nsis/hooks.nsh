!macro NSIS_HOOK_PREINSTALL
  ; Close running AI Proxy instances before overwriting files during an upgrade
  nsExec::ExecToLog 'taskkill /F /IM "AI Proxy.exe" /T'
  Sleep 450
!macroend
