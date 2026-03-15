@echo off
:: Sends the nightly summary email — scheduled for 7:00 AM
set SCRIPT_DIR=%~dp0
set PYTHON=%USERPROFILE%\python\python.exe
set LOG_DIR=%SCRIPT_DIR%logs
set PATH=%LOCALAPPDATA%\Programs\Tesseract-OCR;%USERPROFILE%\python;%PATH%

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set dt=%%I
set LOG_FILE=%LOG_DIR%\task_%dt:~0,8%.log

echo === Email send: %date% %time% === >> "%LOG_FILE%"
"%PYTHON%" "%SCRIPT_DIR%nightly_loader.py" --send-email >> "%LOG_FILE%" 2>&1
