#requires -RunAsAdministrator
<#
.SYNOPSIS
    Install the Slideshow server as a Windows service via NSSM.

.DESCRIPTION
    1. Verifies Node 20+ and ffmpeg are on PATH.
    2. Copies the repo to $InstallDir (default C:\slideshow), skipping
       platform/linux, node_modules, and .git.
    3. Runs `npm ci --omit=dev` inside the install directory.
    4. Downloads NSSM if not already present at $InstallDir\bin\nssm.exe.
    5. Registers the service with manual start (NOT auto), stdout/stderr to
       rotating files under $InstallDir\logs, restart on failure.

    Re-runnable: the script removes any existing Slideshow service before
    re-registering, so an upgrade is `git pull && install.ps1`.
#>

[CmdletBinding()]
param(
    [string]$InstallDir = "C:\slideshow",
    [string]$ServiceName = "Slideshow",
    [string]$Port = "8080"
)

$ErrorActionPreference = "Stop"

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }
function Info($msg) { Write-Host "[install] $msg" -ForegroundColor Cyan }

# 1. Prereqs
Info "Checking Node.js >= 20 ..."
try {
    $nodeVer = (& node --version) 2>$null
    if ($LASTEXITCODE -ne 0) { throw "node not found" }
} catch { Fail "Node.js not found on PATH. Install Node 20 LTS via 'winget install OpenJS.NodeJS.LTS' and re-run." }

$verNum = [int]($nodeVer -replace 'v([0-9]+).*', '$1')
if ($verNum -lt 20) { Fail "Node $nodeVer detected; need >= 20. Install via 'winget install OpenJS.NodeJS.LTS'." }

Info "Checking ffmpeg ..."
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) { Fail "ffmpeg not found on PATH. Install via 'winget install Gyan.FFmpeg' (or scoop)." }

# Locate the repo root (this script lives at platform\windows\install.ps1).
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Info "Repo root: $RepoRoot"
Info "Install dir: $InstallDir"

# 2. Copy repo
if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir | Out-Null }
$exclude = @("node_modules", ".git", "platform\linux", "logs", "tests")
$robocopyArgs = @($RepoRoot, $InstallDir, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS", "/NP",
                  "/XD", (Join-Path $RepoRoot "node_modules"), (Join-Path $RepoRoot ".git"),
                  (Join-Path $RepoRoot "platform\linux"), (Join-Path $RepoRoot "logs"))
Info "Copying repo (robocopy) ..."
& robocopy @robocopyArgs | Out-Null
# robocopy exit code <8 is success.
if ($LASTEXITCODE -ge 8) { Fail "robocopy failed with code $LASTEXITCODE" }

# 3. Install dependencies
Info "Installing dependencies (npm ci --omit=dev) ..."
Push-Location $InstallDir
try {
    & npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
} finally { Pop-Location }

# 4. NSSM
$BinDir = Join-Path $InstallDir "bin"
$Nssm = Join-Path $BinDir "nssm.exe"
if (-not (Test-Path $Nssm)) {
    if (-not (Test-Path $BinDir)) { New-Item -ItemType Directory -Path $BinDir | Out-Null }
    $Zip = Join-Path $env:TEMP "nssm-2.24.zip"
    Info "Downloading NSSM 2.24 ..."
    Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile $Zip -UseBasicParsing
    $ExtractDir = Join-Path $env:TEMP "nssm-extract"
    if (Test-Path $ExtractDir) { Remove-Item $ExtractDir -Recurse -Force }
    Expand-Archive -Path $Zip -DestinationPath $ExtractDir
    $arch = if ([Environment]::Is64BitOperatingSystem) { "win64" } else { "win32" }
    $src = Join-Path $ExtractDir "nssm-2.24\$arch\nssm.exe"
    if (-not (Test-Path $src)) { Fail "NSSM binary not found at $src after extraction" }
    Copy-Item $src $Nssm -Force
    Remove-Item $Zip -Force
    Remove-Item $ExtractDir -Recurse -Force
}
Info "NSSM at: $Nssm"

# 5. Remove existing service if it exists, then re-register.
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Info "Removing existing service $ServiceName ..."
    & $Nssm stop $ServiceName 2>&1 | Out-Null
    & $Nssm remove $ServiceName confirm 2>&1 | Out-Null
}

$NodePath = (Get-Command node).Source
$ServerScript = Join-Path $InstallDir "src\server.js"
$LogDir = Join-Path $InstallDir "logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

Info "Registering service ..."
& $Nssm install $ServiceName $NodePath $ServerScript | Out-Null
& $Nssm set $ServiceName AppDirectory $InstallDir | Out-Null
& $Nssm set $ServiceName AppStdout (Join-Path $LogDir "stdout.log") | Out-Null
& $Nssm set $ServiceName AppStderr (Join-Path $LogDir "stderr.log") | Out-Null
& $Nssm set $ServiceName AppRotateFiles 1 | Out-Null
& $Nssm set $ServiceName AppRotateBytes 10485760 | Out-Null
& $Nssm set $ServiceName AppEnvironmentExtra "PORT=$Port" | Out-Null
# Manual start; NOT auto on boot per spec.
& $Nssm set $ServiceName Start SERVICE_DEMAND_START | Out-Null
& $Nssm set $ServiceName AppExit Default Restart | Out-Null
& $Nssm set $ServiceName AppRestartDelay 3000 | Out-Null

Info "Service '$ServiceName' registered."
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Green
Write-Host "  - Start:   .\platform\windows\start.bat  (or  $Nssm start $ServiceName)"
Write-Host "  - Stop:    .\platform\windows\stop.bat"
Write-Host "  - Status:  .\platform\windows\status.bat  (or  sc query $ServiceName)"
Write-Host "  - Setup:   http://localhost:$Port/"
Write-Host "  - TV:      http://<this-pc-ip>:$Port/slideshow"
Write-Host ""
Write-Host "Logs:  $LogDir"
Write-Host "Config: %APPDATA%\slideshow\config.json"
