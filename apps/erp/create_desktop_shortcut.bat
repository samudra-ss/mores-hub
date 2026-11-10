@echo off
rem MORES HV - put the app on the desktop. Run once (double-click).
rem
rem Desktop:     MORES HV            - opens MORES HV in its own app window
rem              MORES HV - RAB ROT  - the same, straight into the RAB ROT plans
rem Start menu:  MORES HV folder with both, plus "Stop MORES HV server"
rem
rem Each icon starts the local server in the background when it is not running
rem (no console window) and opens http://127.0.0.1:8000 as an app window.
rem Run this again after moving the folder, so the icons point to the new place.
cd /d "%~dp0"
set "ERP_DIR=%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$dir = $env:ERP_DIR.TrimEnd('\'); $w = New-Object -ComObject WScript.Shell;" ^
  "$desk = [Environment]::GetFolderPath('Desktop');" ^
  "$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'MORES HV'; New-Item -ItemType Directory -Force -Path $menu | Out-Null;" ^
  "$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe';" ^
  "$app = Join-Path $dir 'mores_hv_app.ps1';" ^
  "function Make($folder, $name, $extra, $desc) {" ^
  "  $l = $w.CreateShortcut((Join-Path $folder ($name + '.lnk')));" ^
  "  $l.TargetPath = $ps; $l.Arguments = ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"' + $app + '\" ' + $extra).Trim();" ^
  "  $l.WorkingDirectory = $dir; $l.WindowStyle = 7; $l.IconLocation = (Join-Path $dir 'mores_hv.ico') + ',0';" ^
  "  $l.Description = $desc; $l.Save(); Write-Host ('  created  ' + $folder + '\' + $name) };" ^
  "foreach ($f in @($desk, $menu)) {" ^
  "  Make $f 'MORES HV' '' 'MORES HV - Helicopter View';" ^
  "  Make $f 'MORES HV - RAB ROT' '-Open rab' 'MORES HV - RAB ROT project cost plans' };" ^
  "Make $menu 'Stop MORES HV server' '-Stop' 'Stop the MORES HV background server'"

if errorlevel 1 (
  echo.
  echo Could not create the shortcuts. You can still start MORES HV with start_erp.bat.
) else (
  echo.
  echo Done. Double-click "MORES HV" on your desktop - it opens in its own window.
  echo To stop the background server: Start menu ^> MORES HV ^> Stop MORES HV server.
)
pause
