param(
  [string]$InstallDir = $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'VideoSave\app' } else { Join-Path $env:USERPROFILE 'VideoSave' }),
  [switch]$RemoveTools,
  [switch]$RemoveSettings,
  [switch]$SkipShortcuts,
  [switch]$SkipRegistry,
  [switch]$Silent
)

$ErrorActionPreference = 'Stop'
function Write-Step([string]$msg) {
  if (-not $Silent) { Write-Host "[VideoSave Uninstall] $msg" }
}

$targetDir = [IO.Path]::GetFullPath($InstallDir)
Write-Step "Uninstalling VideoSave from $targetDir (your downloaded video files are NEVER deleted)..."

if (-not $SkipRegistry) {
  $regPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\VideoSave'
  if (Test-Path $regPath) { Remove-Item -Path $regPath -Recurse -Force }
}

if (-not $SkipShortcuts) {
  $startMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\VideoSave'
  if (Test-Path -LiteralPath $startMenuDir) { Remove-Item -LiteralPath $startMenuDir -Recurse -Force }
  $deskShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'VideoSave.lnk'
  if (Test-Path -LiteralPath $deskShortcut) { Remove-Item -LiteralPath $deskShortcut -Force }
}

if (Test-Path -LiteralPath $targetDir) {
  $marker = Join-Path $targetDir 'videosave-install.json'
  if (-not (Test-Path -LiteralPath $marker)) {
    throw "Refusing to remove $targetDir because videosave-install.json marker was not found."
  }
  Remove-Item -LiteralPath $targetDir -Recurse -Force
}

if ($RemoveTools -and $env:LOCALAPPDATA) {
  $toolsDir = Join-Path $env:LOCALAPPDATA 'VideoSave\tools'
  if (Test-Path -LiteralPath $toolsDir) { Remove-Item -LiteralPath $toolsDir -Recurse -Force }
}

if ($RemoveSettings -and $env:LOCALAPPDATA) {
  $settingsFile = Join-Path $env:LOCALAPPDATA 'VideoSave\settings.sqlite'
  if (Test-Path -LiteralPath $settingsFile) { Remove-Item -LiteralPath $settingsFile -Force }
}

Write-Step 'VideoSave has been cleanly uninstalled. Downloaded videos remain untouched.'
