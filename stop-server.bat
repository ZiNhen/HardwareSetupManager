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
powershell -NoProfile -ExecutionPolicy Bypass -Command "$root = (Resolve-Path '.').Path.ToLowerInvariant(); $node = if ($env:NODE_EXE) { $env:NODE_EXE.ToLowerInvariant() } else { '' }; $processes = Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($root) -and $_.CommandLine.ToLowerInvariant().Contains('server.js') -and (-not $node -or $_.ExecutablePath.ToLowerInvariant() -eq $node) }; if (-not $processes) { Write-Host 'Hardware Setup Manager is not running.'; exit 0 }; foreach ($process in $processes) { Stop-Process -Id $process.ProcessId -Force; Write-Host ('Stopped Hardware Setup Manager process ' + $process.ProcessId) }"

pause
