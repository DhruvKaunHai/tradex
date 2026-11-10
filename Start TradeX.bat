@echo off
title TradeX
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>nul
if not errorlevel 1 goto run
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe" & goto run
echo.
echo TradeX needs Node.js, and it is not installed on this computer.
echo.
choice /C YN /M "Install Node.js now (official package, through Windows winget)"
if errorlevel 2 goto end
winget install -e --id OpenJS.NodeJS.LTS
if not exist "%ProgramFiles%\nodejs\node.exe" echo. & echo The install did not finish. Install Node.js from https://nodejs.org and run this file again. & goto end
set "NODE=%ProgramFiles%\nodejs\node.exe"
:run
echo Starting TradeX. Keep this window open. Close it to stop TradeX.
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:8080"
"%NODE%" server\index.js
:end
echo.
pause
