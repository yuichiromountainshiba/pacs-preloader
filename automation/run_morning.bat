@echo off
:: Wrapper for Task Scheduler — runs morning_launcher.py and logs output
set SCRIPT_DIR=%~dp0
set PYTHON=%USERPROFILE%\python\python.exe
set LOG_DIR=%SCRIPT_DIR%logs

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

:: Build log filename from date/time
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set dt=%%I
set LOG_FILE=%LOG_DIR%\morning_%dt:~0,8%.log

echo === Run started: %date% %time% === >> "%LOG_FILE%"
"%PYTHON%" "%SCRIPT_DIR%morning_launcher.py" >> "%LOG_FILE%" 2>&1
echo === Run finished: %date% %time% === >> "%LOG_FILE%"
