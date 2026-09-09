@echo off
title Google Meet JA-VI Translation Service
cd /d "%~dp0translation_service"
python main.py
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Server da dung. Nhan phim bat ky de dong...
    pause
)
