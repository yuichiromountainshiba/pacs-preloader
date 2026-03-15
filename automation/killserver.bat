@echo off
echo Stopping PACS server...
%USERPROFILE%\python\python.exe "%~dp0nightly_loader.py" --stop-server
echo.
pause
