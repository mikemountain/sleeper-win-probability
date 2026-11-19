@echo off
cd /d "%~dp0"
title Win probability site
start "" http://localhost:3000
node server.js
pause
