@echo off
:: ──────────────────────────────────────────────────────────────────
:: Install Windows Task Scheduler tasks for PACS Preloader
::
:: Creates three scheduled tasks:
::   1. 9:00 PM Mon-Fri: Run nightly schedule capture
::   2. 7:00 AM Tue-Sat: Email summary of last night's run
::   3. 8:25 AM Mon-Fri: Morning launcher (Epic + browsers + servers)
::
:: Usage:
::   Double-click to install (no admin needed)
::   To remove:  install_task.bat /remove
:: ──────────────────────────────────────────────────────────────────

set TASK_NIGHTLY=PACS_Nightly_Schedule_Loader
set TASK_EMAIL=PACS_Morning_Summary_Email
set TASK_MORNING=PACS_Morning_Launcher
set SCRIPT_DIR=%~dp0
set LOG_DIR=%SCRIPT_DIR%logs

:: Handle /remove flag
if /i "%1"=="/remove" (
    echo Removing scheduled tasks...
    schtasks /Delete /TN "%TASK_NIGHTLY%" /F 2>nul
    schtasks /Delete /TN "%TASK_EMAIL%" /F 2>nul
    schtasks /Delete /TN "%TASK_MORNING%" /F 2>nul
    echo Done.
    pause
    exit /b 0
)

:: Create required folders
if not exist "%SCRIPT_DIR%schedule_inbox" mkdir "%SCRIPT_DIR%schedule_inbox"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

echo.
echo === PACS Preloader — Task Scheduler Setup ===
echo.

:: ── Task 1: Nightly capture at 9 PM Mon-Fri ──
echo Creating nightly capture task (9:00 PM Mon-Fri)...
schtasks /Create /TN "%TASK_NIGHTLY%" ^
    /TR "\"%SCRIPT_DIR%run_nightly.bat\"" ^
    /SC WEEKLY /D MON,TUE,WED,THU,FRI ^
    /ST 21:00 ^
    /RL LIMITED ^
    /F

if %errorlevel% equ 0 (
    echo   OK: %TASK_NIGHTLY%
) else (
    echo   FAILED: %TASK_NIGHTLY%
)

:: ── Task 2: Email summary at 7 AM Tue-Sat ──
echo Creating morning email task (7:00 AM Tue-Sat)...
schtasks /Create /TN "%TASK_EMAIL%" ^
    /TR "\"%SCRIPT_DIR%send_summary.bat\"" ^
    /SC WEEKLY /D TUE,WED,THU,FRI,SAT ^
    /ST 07:00 ^
    /RL LIMITED ^
    /F

if %errorlevel% equ 0 (
    echo   OK: %TASK_EMAIL%
) else (
    echo   FAILED: %TASK_EMAIL%
)

:: ── Task 3: Morning launcher at 8:25 AM Mon-Fri ──
echo Creating morning launcher task (8:25 AM Mon-Fri)...
schtasks /Create /TN "%TASK_MORNING%" ^
    /TR "\"%SCRIPT_DIR%run_morning.bat\"" ^
    /SC WEEKLY /D MON,TUE,WED,THU,FRI ^
    /ST 08:25 ^
    /RL LIMITED ^
    /F

if %errorlevel% equ 0 (
    echo   OK: %TASK_MORNING%
) else (
    echo   FAILED: %TASK_MORNING%
)

echo.
echo ── Setup ──
echo   1. Store email creds:  python nightly_loader.py --setup-email
echo   2. Test email:         python nightly_loader.py --send-email
echo   3. Test capture:       run_nightly.bat
echo   4. View logs:          dir "%LOG_DIR%\*.log"
echo   5. Test morning:       run_morning.bat
echo   6. Remove tasks:       install_task.bat /remove
echo.
pause
