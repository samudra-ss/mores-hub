@echo off
rem MORES RAB ROT - one-time setup. Double-click this file.
rem   1. installs the two Python packages the app needs (Flask, openpyxl)
rem   2. puts the MORES RAB ROT icon on your desktop and in the Start menu
rem Run it again after moving this folder, so the icons point to the new place.
title MORES RAB ROT - setup
cd /d "%~dp0"
set "RR_DIR=%~dp0"

echo.
echo [1/2] Installing the Python packages...
where python >nul 2>&1
if not errorlevel 1 (
  python -m pip install --disable-pip-version-check -q -r requirements.txt
) else (
  py -3 -m pip install --disable-pip-version-check -q -r requirements.txt
)
if errorlevel 1 (
  echo.
  echo Python or pip was not found. Install Python 3 from python.org
  echo and tick "Add python.exe to PATH", then run this file again.
  pause
  exit /b 1
)

echo [2/2] Creating the icons...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$dir = $env:RR_DIR.TrimEnd('\'); $w = New-Object -ComObject WScript.Shell;" ^
  "$desk = [Environment]::GetFolderPath('Desktop');" ^
  "$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'MORES RAB ROT'; New-Item -ItemType Directory -Force -Path $menu | Out-Null;" ^
  "$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe';" ^
  "$app = Join-Path $dir 'rab_rot_app.ps1';" ^
  "function Make($folder, $name, $extra, $desc) {" ^
  "  $l = $w.CreateShortcut((Join-Path $folder ($name + '.lnk')));" ^
  "  $l.TargetPath = $ps; $l.Arguments = ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"' + $app + '\" ' + $extra).Trim();" ^
  "  $l.WorkingDirectory = $dir; $l.WindowStyle = 7; $l.IconLocation = (Join-Path $dir 'rab_rot.ico') + ',0';" ^
  "  $l.Description = $desc; $l.Save(); Write-Host ('  created  ' + $folder + '\' + $name) };" ^
  "Make $desk 'MORES RAB ROT' '' 'MORES RAB ROT - project cost plan and remuneration';" ^
  "Make $menu 'MORES RAB ROT' '' 'MORES RAB ROT - project cost plan and remuneration';" ^
  "Make $menu 'Stop MORES RAB ROT' '-Stop' 'Stop the MORES RAB ROT background app'"

if errorlevel 1 (
  echo.
  echo Could not create the icons. You can still run the app: python app.py
) else (
  echo.
  echo Done. Double-click "MORES RAB ROT" on your desktop - it opens in its own window.
  echo To stop it: Start menu ^> MORES RAB ROT ^> Stop MORES RAB ROT.
)
pause
