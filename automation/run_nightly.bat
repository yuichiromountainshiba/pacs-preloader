@echo off
:: Wrapper for Task Scheduler — runs nightly_loader.py and logs output
set SCRIPT_DIR=%~dp0
set PYTHON=%USERPROFILE%\python\python.exe
set LOG_DIR=%SCRIPT_DIR%logs

:: Add Tesseract and Python to PATH so subprocesses can find them
set PATH=%LOCALAPPDATA%\Programs\Tesseract-OCR;%USERPROFILE%\python;%PATH%

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

:: Build log filename from date/time
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set dt=%%I
set LOG_FILE=%LOG_DIR%\task_%dt:~0,8%.log

echo === Run started: %date% %time% === >> "%LOG_FILE%"
"%PYTHON%" "%SCRIPT_DIR%nightly_loader.py" >> "%LOG_FILE%" 2>&1
echo === Run finished: %date% %time% === >> "%LOG_FILE%"
