@echo off
REM Double-click to stop the Slideshow service.
NET SESSION >nul 2>&1
if %errorLevel% NEQ 0 (
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)
"%~dp0..\..\bin\nssm.exe" stop Slideshow
echo Slideshow stopped.
pause
