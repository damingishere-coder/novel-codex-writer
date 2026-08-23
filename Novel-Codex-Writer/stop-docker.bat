@echo off
setlocal

cd /d "%~dp0"

docker compose version >nul 2>nul
if errorlevel 1 (
  echo Docker was not found. Please install Docker Desktop first.
  pause
  exit /b 1
)

docker info >nul 2>nul
if errorlevel 1 (
  echo Docker Desktop is not running. The web service is already unreachable.
  pause
  exit /b 0
)

echo Stopping Novel Codex Workbench...
docker compose down
if errorlevel 1 (
  echo Stop failed. Please make sure Docker Desktop is running.
  pause
  exit /b 1
)

echo Done. The web page service has stopped.
pause
