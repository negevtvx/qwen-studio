@echo off
setlocal
title Qwen Studio
cd /d "%~dp0"
set "PORT=8190"
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "try { (Get-Content -Raw 'config\settings.json' | ConvertFrom-Json).app.port } catch { 8190 }"`) do set "PORT=%%p"
set "URL=http://127.0.0.1:%PORT%/"
set "EXTRA="
if /i "%~1"=="incognito" set "EXTRA=?incognito=1"

where node >nul 2>nul || (
  echo Node.js 22 or newer is required. Double-click Install.bat
  pause
  exit /b 1
)

if not exist "config\settings.json" (
  echo Run Install.bat first. It downloads the model for your graphics card.
  pause
  exit /b 1
)

curl -s -o nul --max-time 1 "%URL%api/ping" && goto open

if not exist data mkdir data
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath node -ArgumentList 'server.mjs' -WorkingDirectory '%~dp0.' -WindowStyle Hidden -RedirectStandardOutput 'data\server.log' -RedirectStandardError 'data\server.err.log'"

for /l %%i in (1,1,40) do (
  curl -s -o nul --max-time 1 "%URL%api/ping" && goto open
  ping -n 2 127.0.0.1 >nul
)
echo Qwen Studio did not start. See data\server.log and data\server.err.log
pause
exit /b 1

:open
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  if defined EXTRA (
    start "" "%EDGE%" --inprivate --app=%URL%%EXTRA% --window-size=1680,1020
  ) else (
    start "" "%EDGE%" --app=%URL% --window-size=1680,1020
  )
) else (
  start "" "%URL%%EXTRA%"
)
exit /b 0
