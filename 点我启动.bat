@echo off
title ChessCraft - Local Server
cd /d "%~dp0"

echo ========================================
echo  ChessCraft local server
echo  Page will open at http://localhost:8765
echo  Keep this window open; closing stops it
echo ========================================
echo.
start "" http://localhost:8765
node server.js
echo.
pause
