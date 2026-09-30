@echo off
setlocal
title Living Diplomacy - Player2 Companion
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Living Diplomacy could not start: Node.js is not installed or is not on PATH.
  echo Install the Windows LTS version from https://nodejs.org, then run this BAT again.
  if /i "%~1"=="--check" exit /b 1
  pause
  exit /b 1
)
node scripts\start-workshop.js %*
set "LLMDIP_EXIT_CODE=%errorlevel%"
if /i "%~1"=="--check" exit /b %LLMDIP_EXIT_CODE%
echo.
echo The Living Diplomacy companion has stopped. Any error is shown above.
pause
exit /b %LLMDIP_EXIT_CODE%
