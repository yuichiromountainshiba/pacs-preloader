@echo off
:: Launch Chrome with background-tab throttling disabled, so the PACS preloader
:: can drive multiple parallel tabs at full speed regardless of window focus
:: or occlusion. Uses your normal Chrome profile so the InteleBrowser login
:: persists.
::
:: Pin this .bat (or a shortcut to it) to your taskbar instead of the default
:: Chrome icon for any session where you intend to run the preloader.

setlocal

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
