@echo off
REM Double-click to start the Slideshow service.
NET SESSION >nul 2>&1
if %errorLevel% NEQ 0 (
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)
"%~dp0..\..\bin\nssm.exe" start Slideshow
if errorlevel 1 (
    echo Could not start service.
    echo   - Confirm the service is registered: sc query Slideshow
    echo   - Check %~dp0..\..\logs\stderr.log for service-side errors.
) else (
    echo Slideshow started. Open http://localhost:8080/ to configure.
)
pause
