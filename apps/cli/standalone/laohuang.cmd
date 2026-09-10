@echo off
setlocal DisableDelayedExpansion
set "PATH=%~dp0runtime;%PATH%"
if "%~1"=="update" if "%~2"=="" goto update
if "%~1"=="update" if "%~3"=="" if "%~2"=="--help" goto update_help
if "%~1"=="update" if "%~3"=="" if "%~2"=="-h" goto update_help
"%~dp0runtime\node.exe" "%~dp0app\node_modules\laohuang\dist\bin.js" %*
exit /b %errorlevel%
:update_help
echo laohuang update: install the latest standalone release into this installation.
exit /b 0
:update
for %%I in ("%~dp0..\..") do set "LAOHUANG_INSTALL_DIR=%%~fI"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
exit /b %errorlevel%
