@echo off
chcp 65001 > nul
echo =======================================================
echo    Starting Google Meet JA-VI Translation Service
echo =======================================================
cd /d "%~dp0"
python main.py
pause
