@echo off
setlocal
title WeChat Markdown Publisher - Installer

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo Installation failed. Please keep this window and check the error above.
  pause
  exit /b 1
)

echo.
echo Installation completed. The editor will open in your browser.
pause
endlocal
