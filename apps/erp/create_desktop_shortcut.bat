@echo off
rem MORES HV - put the app on the desktop. Run once (double-click).
rem Makes two shortcuts, both with the MORES HV icon:
rem   MORES HV            - starts the app and opens it in the browser
rem   MORES HV - RAB ROT  - the same, straight into Remuneration > RAB ROT plan
rem Run it again after moving the folder, so the shortcuts point to the new place.
cd /d "%~dp0"
set "ERP_DIR=%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$d = [Environment]::GetFolderPath('Desktop'); $w = New-Object -ComObject WScript.Shell; $dir = $env:ERP_DIR.TrimEnd('\');" ^
  "foreach ($s in @(@('MORES HV', '', 'MORES HV - Helicopter View'), @('MORES HV - RAB ROT', 'rab', 'MORES HV - RAB ROT project cost plans'))) {" ^
  "  $l = $w.CreateShortcut((Join-Path $d ($s[0] + '.lnk')));" ^
  "  $l.TargetPath = Join-Path $dir 'start_erp.bat'; $l.Arguments = $s[1]; $l.WorkingDirectory = $dir;" ^
  "  $l.IconLocation = (Join-Path $dir 'mores_hv.ico') + ',0'; $l.Description = $s[2]; $l.Save();" ^
  "  Write-Host ('  created  ' + (Join-Path $d ($s[0] + '.lnk')))" ^
  "}"

if errorlevel 1 (
  echo.
  echo Could not create the shortcuts. Right-click start_erp.bat ^> Send to ^> Desktop instead.
) else (
  echo.
  echo Done - look for "MORES HV" and "MORES HV - RAB ROT" on your desktop.
)
pause
