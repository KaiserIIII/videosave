@echo off
setlocal
set "PSModulePath="
set "videosaveShell=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "videosaveShell=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
"%videosaveShell%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-windows.ps1" %*
set "videosaveExit=%errorlevel%"
if not "%videosaveExit%"=="0" pause
exit /b %videosaveExit%
