@echo off
setlocal
cd /d "%~dp0"

if not defined NODE_EXE set "NODE_EXE=%~dp0nodejs\node.exe"

if not exist "%NODE_EXE%" (
    if exist "C:\NAR5HC\nodejs\node.exe" set "NODE_EXE=C:\NAR5HC\nodejs\node.exe"
)

if not exist "%NODE_EXE%" (
    where node >nul 2>nul
    if not errorlevel 1 (
        for /f "delims=" %%I in ('where node') do (
            set "NODE_EXE=%%I"
            goto :node_found
        )
    )
)

:node_found
if not exist "%NODE_EXE%" (
    echo Node.js was not found.
    echo Expected default: %~dp0nodejs\node.exe
    echo Or set NODE_EXE to your node.exe path before running this file.
    pause
    exit /b 1
)

if not exist logs mkdir logs

powershell -NoProfile -ExecutionPolicy Bypass -Command "$root = (Resolve-Path '.').Path; $node = $env:NODE_EXE; $out = Join-Path $root 'logs\server.log'; $err = Join-Path $root 'logs\server-error.log'; Start-Process -FilePath $node -ArgumentList @('--no-warnings','server.js') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err"

echo Hardware Setup Manager is running in the background.
echo Open http://localhost:3000 on this PC, or http://SERVER_IP:3000 from another LAN device.
echo Logs: logs\server.log and logs\server-error.log
echo Use stop-server.bat to stop it.
pause
