@echo off
rem PLaMo 3 Translate server (llama-server) - start hidden
rem Put this file in the same folder as plamo-3-translate-2b-Q4_K_M.gguf
rem (the folder path must not contain spaces)

tasklist /FI "IMAGENAME eq llama-server.exe" | find /I "llama-server.exe" >nul
if not errorlevel 1 (
  echo PLaMo server is already running.
  timeout /t 2 >nul
  exit /b
)

powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath 'llama-server' -ArgumentList '-m %~dp0plamo-3-translate-2b-Q4_K_M.gguf -c 8192 --port 8000 --alias plamo-3-translate' -WindowStyle Hidden -RedirectStandardError '%~dp0llama-server.log' -RedirectStandardOutput '%~dp0llama-server-out.log'"
