$ErrorActionPreference = "Stop"

$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$FrontendRoot = Join-Path $ProjectRoot "frontend"
$RuntimeRoot = Join-Path $ProjectRoot ".runtime"
$StateFile = Join-Path $RuntimeRoot "novel-codex-native.json"
$StdOutLog = Join-Path $RuntimeRoot "novel-codex-native.out.log"
$StdErrLog = Join-Path $RuntimeRoot "novel-codex-native.err.log"
$Port = 5174
$HostAddress = "127.0.0.1"

New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null

function Get-ListeningPids {
  try {
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
      Select-Object -ExpandProperty OwningProcess -Unique
    return
  } catch {
    $portPattern = [regex]::Escape([string]$Port)
    netstat -ano -p tcp 2>$null | ForEach-Object {
      if ($_ -match ":$portPattern\s+\S+\s+LISTENING\s+(\d+)$") {
        [int]$matches[1]
      }
    }
  }
}

function Get-ProcessStartUtc([int]$ProcessId) {
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $process) { return $null }
  try { return $process.StartTime.ToUniversalTime() } catch { return $null }
}

if (Test-Path -LiteralPath $StateFile) {
  try {
    $state = Get-Content -Raw -LiteralPath $StateFile | ConvertFrom-Json
    $recordedRoot = [System.IO.Path]::GetFullPath([string]$state.projectRoot).TrimEnd('\')
    $recordedStart = if ($state.startTimeUtc -is [DateTime]) {
      $state.startTimeUtc.ToUniversalTime()
    } else {
      [DateTime]::ParseExact(
        [string]$state.startTimeUtc,
        "o",
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind
      ).ToUniversalTime()
    }
    $actualStart = Get-ProcessStartUtc ([int]$state.pid)
    if ($recordedRoot -ieq $ProjectRoot.TrimEnd('\') -and $actualStart -and [Math]::Abs(($actualStart - $recordedStart).TotalSeconds) -le 5) {
      Write-Host "Novel Codex 本机服务已经在运行：http://$HostAddress`:$Port/"
      Start-Process "http://$HostAddress`:$Port/"
      exit 0
    }
  } catch {
    # 状态文件损坏或对应进程已退出，下面会安全重建本项目自己的状态。
  }
  Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
}

$occupiedPids = @(Get-ListeningPids | Sort-Object -Unique)
if ($occupiedPids.Count -gt 0) {
  $owners = $occupiedPids -join ", "
  Write-Host "错误：端口 $Port 已被其他进程占用（PID: $owners），未启动 Novel-Codex-Writer。"
  exit 1
}

$npmCommand = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npmCommand) {
  Write-Host "错误：未找到 npm.cmd，请先安装 Node.js。"
  exit 1
}

$viteCommand = Join-Path $FrontendRoot "node_modules\.bin\vite.cmd"
if (-not (Test-Path -LiteralPath $viteCommand)) {
  Write-Host "首次启动：正在运行 npm ci 安装前端依赖..."
  Push-Location $FrontendRoot
  try {
    & $npmCommand ci --no-audit --prefer-offline
    if ($LASTEXITCODE -ne 0) { throw "npm ci 失败，退出码 $LASTEXITCODE。" }
  } finally {
    Pop-Location
  }
}

Write-Host "正在启动 Novel-Codex-Writer 本机服务（127.0.0.1:$Port）..."
$nativeProcess = Start-Process -FilePath $npmCommand `
  -ArgumentList @("run", "dev", "--", "--host", $HostAddress, "--port", [string]$Port, "--strictPort") `
  -WorkingDirectory $FrontendRoot `
  -RedirectStandardOutput $StdOutLog `
  -RedirectStandardError $StdErrLog `
  -WindowStyle Hidden `
  -PassThru

Start-Sleep -Milliseconds 300
$startedAt = Get-ProcessStartUtc $nativeProcess.Id
if (-not $startedAt) {
  Write-Host "错误：本机服务进程未能启动，详见 .runtime 日志。"
  exit 1
}

[ordered]@{
  projectRoot = $ProjectRoot
  pid = [int]$nativeProcess.Id
  startTimeUtc = $startedAt.ToString("o")
  host = $HostAddress
  port = $Port
  command = "npm run dev -- --host $HostAddress --port $Port --strictPort"
} | ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding UTF8

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Seconds 1
  if (@(Get-ListeningPids).Count -gt 0) { $ready = $true; break }
  if (-not (Get-Process -Id $nativeProcess.Id -ErrorAction SilentlyContinue)) { break }
}

if (-not $ready) {
  Write-Host "错误：本机服务未在端口 $Port 监听，详见 .runtime 日志。"
  exit 1
}

Write-Host "启动完成：http://$HostAddress`:$Port/"
Start-Process "http://$HostAddress`:$Port/"
exit 0
