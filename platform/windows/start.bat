@echo off
REM Double-click to start the Slideshow service.
"%~dp0..\..\bin\nssm.exe" start Slideshow
if errorlevel 1 (
    echo Could not start service. Did you run install.ps1 as Administrator?
) else (
    echo Slideshow started. Open http://localhost:8080/ to configure.
)
pause
