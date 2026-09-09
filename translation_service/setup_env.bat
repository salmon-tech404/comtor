@echo off
chcp 65001 > nul
echo =======================================================
echo    Google Meet JA-VI Translation Service Setup
echo =======================================================
cd /d "%~dp0"
python setup_and_download.py
pause
