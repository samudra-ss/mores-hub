@echo off
title MORES ERP
cd /d "%~dp0"
echo Starting MORES ERP at http://127.0.0.1:8000 ...
start "" http://127.0.0.1:8000
python server.py
pause
