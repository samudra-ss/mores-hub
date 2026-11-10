@echo off
title MORES HV - Helicopter View
cd /d "%~dp0"

rem If the app is already running, just open the browser and exit.
netstat -ano | findstr /c:":8000" | findstr /i "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo MORES HV is already running - opening browser...
  start "" "http://127.0.0.1:8000"
  timeout /t 1 >nul
  exit /b 0
)

echo ============================================
echo   MORES HV - Helicopter View
echo   Starting at http://127.0.0.1:8000
echo   Keep this window open while you use the app.
echo   Close it to stop the server.
echo ============================================

rem Open the browser a few seconds after the server boots (hidden helper).
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:8000'"

python server.py

echo.
echo MORES HV server stopped. Press any key to close.
pause >nul
