@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found. Install Node.js 24 LTS or newer, then run this file again.
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

call npm start
