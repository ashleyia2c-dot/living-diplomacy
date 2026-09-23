@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Falta Node.js 20 o superior. Instala Node.js desde https://nodejs.org.
  pause
  exit /b 1
)
node scripts\start-workshop.js
pause
