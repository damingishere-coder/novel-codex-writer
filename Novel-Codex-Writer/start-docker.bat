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
  echo Docker Desktop is not running. Trying to start it now...
  if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
  if exist "%LocalAppData%\Docker\Docker Desktop.exe" start "" "%LocalAppData%\Docker\Docker Desktop.exe"
  call :wait_for_docker
  if errorlevel 1 (
    echo Docker Desktop did not become ready in time.
    echo Please open Docker Desktop manually, wait until it finishes starting, then run this file again.
    pause
    exit /b 1
  )
)

call :prepare_node_image
if errorlevel 1 (
  pause
  exit /b 1
)

echo Starting Novel Codex Workbench in Docker...
docker compose up --build -d
if errorlevel 1 (
  echo Start failed. Please make sure Docker Desktop is running.
  pause
  exit /b 1
)

call :share_codex_login

echo Done. Opening http://localhost:5173/
start "" "http://localhost:5173/"
echo If the page is still loading, wait 10-20 seconds and refresh.
pause
exit /b 0

:share_codex_login
if not exist "%USERPROFILE%\.codex\auth.json" (
  echo Codex App login was not found. DeepSeek and normal editing can still be used.
  exit /b 0
)
docker exec novel-codex-workbench sh -c "mkdir -p /root/.codex" >nul 2>nul
docker cp "%USERPROFILE%\.codex\auth.json" novel-codex-workbench:/root/.codex/auth.json >nul 2>nul
if errorlevel 1 (
  echo Warning: Codex App login could not be shared with the workbench.
  exit /b 0
)
echo Codex App login is ready for deep review.
exit /b 0

:wait_for_docker
for /l %%i in (1,1,60) do (
  docker info >nul 2>nul
  if not errorlevel 1 exit /b 0
  timeout /t 2 /nobreak >nul
)
exit /b 1

:prepare_node_image
docker image inspect novel-codex-node:22 >nul 2>nul
if not errorlevel 1 exit /b 0

docker image inspect ai-jobpilot-frontend:latest >nul 2>nul
if not errorlevel 1 (
  echo Preparing local Node image from an existing Docker image...
  docker tag ai-jobpilot-frontend:latest novel-codex-node:22
  exit /b %errorlevel%
)

echo Local Node image was not found. Trying to download node:22-alpine...
docker pull node:22-alpine
if errorlevel 1 (
  echo Could not download the Node image.
  echo Please check your network or Docker registry connection, then run this file again.
  exit /b 1
)

docker tag node:22-alpine novel-codex-node:22
exit /b %errorlevel%
