param(
  [string]$InstallDir = $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'VideoSave\app' } else { Join-Path $env:USERPROFILE 'VideoSave' }),
  [switch]$DesktopShortcut,
  [switch]$SkipComponents,
  [switch]$SkipShortcuts,
  [switch]$SkipRegistry,
  [switch]$Silent
)

$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $sourceRoot 'extension\manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = if ($manifest.version_name) { $manifest.version_name } else { $manifest.version }

function Write-Step([string]$msg) {
  if (-not $Silent) { Write-Host "[VideoSave Setup v$version] $msg" }
}

$targetDir = [IO.Path]::GetFullPath($InstallDir)
$parentDir = Split-Path -Parent $targetDir
$backupDir = "$targetDir.rollback-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$stagingDir = "$targetDir.staging-$([guid]::NewGuid().ToString('N').Substring(0,8))"

Write-Step "Installing VideoSave $version to $targetDir (no admin rights required, system PATH untouched)..."
[IO.Directory]::CreateDirectory($parentDir) | Out-Null
[IO.Directory]::CreateDirectory($stagingDir) | Out-Null

$copyDirs = @('extension', 'tools', 'docs')
$copyFiles = @('LICENSE', 'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'SECURITY.md', 'Start VideoSave.cmd', 'Install VideoSave.cmd', 'Uninstall VideoSave.cmd')

$hadPrior = Test-Path -LiteralPath $targetDir
try {
  foreach ($dir in $copyDirs) {
    $src = Join-Path $sourceRoot $dir
    if (Test-Path -LiteralPath $src) {
      Copy-Item -LiteralPath $src -Destination (Join-Path $stagingDir $dir) -Recurse -Force
    }
  }
  foreach ($file in $copyFiles) {
    $src = Join-Path $sourceRoot $file
    if (Test-Path -LiteralPath $src) {
      Copy-Item -LiteralPath $src -Destination (Join-Path $stagingDir $file) -Force
    }
  }
  @{
    version = $version
    installedAt = [DateTime]::UtcNow.ToString('o')
    installDir = $targetDir
    mode = 'user-setup'
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stagingDir 'videosave-install.json') -Encoding UTF8

  if ($hadPrior) {
    [IO.Directory]::Move($targetDir, $backupDir)
  }
  [IO.Directory]::Move($stagingDir, $targetDir)

  if (-not $SkipComponents) {
    Write-Step 'Preparing pinned local runtime components (Node.js 24, FFmpeg 8.1.2, yt-dlp)...'
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $targetDir 'tools\start-windows.ps1') -SetupOnly
    if ($LASTEXITCODE -ne 0) { throw "Runtime component setup failed with exit code $LASTEXITCODE" }
  }

  if (-not $SkipShortcuts) {
    $wsh = New-Object -ComObject WScript.Shell
    $startMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\VideoSave'
    [IO.Directory]::CreateDirectory($startMenuDir) | Out-Null

    $launchShortcut = $wsh.CreateShortcut((Join-Path $startMenuDir 'VideoSave.lnk'))
    $launchShortcut.TargetPath = Join-Path $targetDir 'Start VideoSave.cmd'
    $launchShortcut.WorkingDirectory = $targetDir
    $launchShortcut.Description = 'Start VideoSave Companion and Local Management Center'
    $launchShortcut.Save()

    $uninstShortcut = $wsh.CreateShortcut((Join-Path $startMenuDir 'Uninstall VideoSave.lnk'))
    $uninstShortcut.TargetPath = Join-Path $targetDir 'Uninstall VideoSave.cmd'
    $uninstShortcut.WorkingDirectory = $targetDir
    $uninstShortcut.Description = 'Uninstall VideoSave (keeps your downloaded videos)'
    $uninstShortcut.Save()

    if ($DesktopShortcut) {
      $desktopDir = [Environment]::GetFolderPath('Desktop')
      $deskShortcut = $wsh.CreateShortcut((Join-Path $desktopDir 'VideoSave.lnk'))
      $deskShortcut.TargetPath = Join-Path $targetDir 'Start VideoSave.cmd'
      $deskShortcut.WorkingDirectory = $targetDir
      $deskShortcut.Description = 'Start VideoSave'
      $deskShortcut.Save()
    }
  }

  if (-not $SkipRegistry) {
    $regPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\VideoSave'
    New-Item -Path $regPath -Force | Out-Null
    Set-ItemProperty -Path $regPath -Name 'DisplayName' -Value 'VideoSave'
    Set-ItemProperty -Path $regPath -Name 'DisplayVersion' -Value $version
    Set-ItemProperty -Path $regPath -Name 'Publisher' -Value 'VideoSave Contributors'
    Set-ItemProperty -Path $regPath -Name 'InstallLocation' -Value $targetDir
    Set-ItemProperty -Path $regPath -Name 'UninstallString' -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$targetDir\tools\uninstall-windows.ps1`""
    Set-ItemProperty -Path $regPath -Name 'URLInfoAbout' -Value 'https://kaiseriiii.github.io/videosave/'
    Set-ItemProperty -Path $regPath -Name 'NoModify' -Value 1 -Type DWord
    Set-ItemProperty -Path $regPath -Name 'NoRepair' -Value 1 -Type DWord
  }

  if (Test-Path -LiteralPath $backupDir) {
    Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Step "Installation complete! Launch via Start Menu -> VideoSave or run: $targetDir\Start VideoSave.cmd"
  Write-Step "Local Management Center: http://127.0.0.1:8765/console"
} catch {
  Write-Error "Installation failed, rolling back: $_"
  if (Test-Path -LiteralPath $stagingDir) { Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue }
  if ($hadPrior -and (Test-Path -LiteralPath $backupDir)) {
    if (Test-Path -LiteralPath $targetDir) { Remove-Item -LiteralPath $targetDir -Recurse -Force -ErrorAction SilentlyContinue }
    [IO.Directory]::Move($backupDir, $targetDir)
  }
  exit 1
}
