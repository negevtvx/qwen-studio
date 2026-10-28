@echo off
setlocal
cd /d "%~dp0"
title Qwen Studio setup
echo.
echo  Qwen Studio setup
echo  Downloads the Turbo model that fits your GPU, then opens the app.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install.ps1" %*
if errorlevel 1 (
  echo.
  echo Setup did not finish.
  pause
  exit /b 1
)
exit /b 0
