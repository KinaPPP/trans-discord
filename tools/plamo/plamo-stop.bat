@echo off
rem PLaMo 3 Translate server (llama-server) - stop

taskkill /IM llama-server.exe /F >nul 2>&1
if errorlevel 1 (
  echo PLaMo server is not running.
) else (
  echo PLaMo server stopped.
)
timeout /t 2 >nul
