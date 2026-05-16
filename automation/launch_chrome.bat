@echo off
:: One-click clinic launcher:
::   1. Starts the local PACS FastAPI server (backend\server.py on :8888)
::   2. Starts the keep-awake ticker so the screen-lock policy stays off
::   3. Launches Chrome with background-tab throttling disabled, so the
::      preloader can drive multiple parallel tabs at full speed regardless
::      of window focus or occlusion. Uses your normal Chrome profile so
::      the InteleBrowser login persists.
::
:: Pin this .bat (or a shortcut to it) to your taskbar instead of the default
:: Chrome icon for any session where you intend to run the preloader. Safe
:: to double-click again — server and keep-awake are skipped if already up.

setlocal

set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%.."
set "SERVER_SCRIPT=%PROJECT_DIR%\backend\server.py"
set "KEEPAWAKE_BAT=%SCRIPT_DIR%keep_awake.bat"

:: ── 1. Start the PACS server if nothing is listening on :8888 ──
netstat -ano | findstr /R /C:"LISTENING" | findstr /C:":8888 " >nul 2>&1
if errorlevel 1 (
  if exist "%SERVER_SCRIPT%" (
    echo Starting PACS server ^(backend\server.py^) on :8888 ...
    start "pacs-server" cmd /k "cd /d "%PROJECT_DIR%" && python "%SERVER_SCRIPT%""
  ) else (
    echo WARNING: backend\server.py not found at "%SERVER_SCRIPT%" — skipping server.
  )
) else (
  echo PACS server already listening on :8888 — leaving it alone.
)

:: ── 2. Start the keep-awake ticker unless one is already running ──
tasklist /v /fi "imagename eq powershell.exe" 2>nul | findstr /i "keep-awake" >nul
if errorlevel 1 (
  if exist "%KEEPAWAKE_BAT%" (
    echo Starting keep-awake ticker ...
    call "%KEEPAWAKE_BAT%"
  ) else (
    echo WARNING: keep_awake.bat not found next to launch_chrome.bat — skipping.
  )
) else (
  echo keep-awake already running — leaving it alone.
)

:: ── 3. Launch Chrome ──
set "CHROME="
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

if not defined CHROME (
  echo Could not find chrome.exe in standard locations.
  echo Edit launch_chrome.bat to set CHROME manually.
  pause
  exit /b 1
)

:: Primary window opens PACS; a separate window opens the Mira viewer.
:: Extra args (%*) are appended in case you want to add more URLs.
start "" "%CHROME%" ^
  --disable-background-timer-throttling ^
  --disable-renderer-backgrounding ^
  --disable-backgrounding-occluded-windows ^
  https://pacs.renoortho.com ^
  --new-window https://dev.mirahealth.care ^
  %*

endlocal
