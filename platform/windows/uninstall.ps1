#requires -RunAsAdministrator
<#
.SYNOPSIS
    Stops and unregisters the Slideshow Windows service.

.DESCRIPTION
    Removes the NSSM-registered "Slideshow" service. Leaves the install
    directory and the user config under %APPDATA%\slideshow alone so a
    reinstall can pick up where it left off.
#>

[CmdletBinding()]
param(
    [string]$InstallDir = "C:\slideshow",
    [string]$ServiceName = "Slideshow"
)

$ErrorActionPreference = "Stop"
$Nssm = Join-Path $InstallDir "bin\nssm.exe"
if (-not (Test-Path $Nssm)) {
    Write-Host "NSSM not found at $Nssm; nothing to do." -ForegroundColor Yellow
    exit 0
}
& $Nssm stop $ServiceName 2>$null | Out-Null
& $Nssm remove $ServiceName confirm | Out-Null
Write-Host "Service '$ServiceName' removed." -ForegroundColor Green
Write-Host "Note: user config under %APPDATA%\slideshow is preserved. Delete it manually if you want a clean wipe."
