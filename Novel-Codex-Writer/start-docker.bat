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

echo Starting Novel Codex Workbench in Docker...
docker compose up --build -d
if errorlevel 1 (
  echo Start failed. Please make sure Docker Desktop is running.
  pause
  exit /b 1
)

echo Waiting for the workbench health check...
call :wait_for_workbench
if errorlevel 1 (
  echo The workbench container did not become healthy in time.
  docker compose ps
  docker compose logs --tail 50 web
  pause
  exit /b 1
)

call :share_codex_login

echo Done. Opening http://127.0.0.1:5173/
start "" "http://127.0.0.1:5173/"
pause
exit /b 0

:wait_for_workbench
for /l %%i in (1,1,90) do (
  call :workbench_is_healthy
  if not errorlevel 1 exit /b 0
  timeout /t 2 /nobreak >nul
)
exit /b 1

:workbench_is_healthy
for /f "usebackq delims=" %%s in (`docker inspect --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" novel-codex-workbench 2^>nul`) do (
  if /i "%%s"=="healthy" exit /b 0
)
exit /b 1

:share_codex_login
if not exist "%USERPROFILE%\.codex\auth.json" (
  echo Codex App login was not found. DeepSeek and normal editing can still be used.
  exit /b 0
)
docker exec -i -u node novel-codex-workbench sh -c "umask 077; mkdir -p /home/node/.codex; cat > /home/node/.codex/auth.json" < "%USERPROFILE%\.codex\auth.json" >nul 2>nul
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
