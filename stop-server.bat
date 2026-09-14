@echo off
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$root = (Resolve-Path '.').Path.ToLowerInvariant(); $processes = Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($root.ToLowerInvariant()) -and $_.CommandLine.ToLowerInvariant().Contains('server.js') }; if (-not $processes) { Write-Host 'Hardware Setup Manager is not running.'; exit 0 }; foreach ($process in $processes) { Stop-Process -Id $process.ProcessId -Force; Write-Host ('Stopped Hardware Setup Manager process ' + $process.ProcessId) }"

pause
