@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found. Install Node.js 24 LTS or newer, then run this file again.
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo npm was not found. Reinstall Node.js with npm enabled, then run this file again.
    pause
    exit /b 1
)

if not exist node_modules\express (
    echo Installing server dependency...
    call npm install
    if errorlevel 1 (
        echo npm install failed.
        pause
        exit /b 1
    )
)

if not exist logs mkdir logs

powershell -NoProfile -ExecutionPolicy Bypass -Command "$root = (Resolve-Path '.').Path; $out = Join-Path $root 'logs\server.log'; $err = Join-Path $root 'logs\server-error.log'; Start-Process -FilePath 'node' -ArgumentList @('--no-warnings','server.js') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err"

echo Hardware Setup Manager is running in the background.
echo Open http://localhost:3000 on this PC, or http://SERVER_IP:3000 from another LAN device.
echo Logs: logs\server.log and logs\server-error.log
echo Use stop-server.bat to stop it.
pause
