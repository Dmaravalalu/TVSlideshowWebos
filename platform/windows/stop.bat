@echo off
REM Double-click to stop the Slideshow service.
"%~dp0..\..\bin\nssm.exe" stop Slideshow
echo Slideshow stopped.
pause
