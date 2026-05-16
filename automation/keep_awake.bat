@echo off
:: Launches keep_awake.ps1 in a minimized window, so the inactivity timer
:: keeps getting reset while you're seeing patients.
::
:: Double-click this when you start clinic. To stop: open the minimized
:: "keep-awake" window from the taskbar and close it (or Ctrl+C inside it).

setlocal
set "SCRIPT=%~dp0keep_awake.ps1"

if not exist "%SCRIPT%" (
  echo Could not find keep_awake.ps1 next to this .bat
  pause
  exit /b 1
)

start /min "keep-awake" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
endlocal
