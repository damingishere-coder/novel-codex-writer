$ErrorActionPreference = "Stop"

$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$RuntimeRoot = Join-Path $ProjectRoot ".runtime"
$StateFile = Join-Path $RuntimeRoot "novel-codex-native.json"
$Port = 5174

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

if (-not (Test-Path -LiteralPath $StateFile)) {
  Write-Host "没有找到 Novel-Codex-Writer 的本机进程记录，未结束任何进程。"
  exit 0
}

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
  $processId = [int]$state.pid
  if ($recordedRoot -ine $ProjectRoot.TrimEnd('\') -or [int]$state.port -ne $Port -or $processId -le 0) {
    throw "状态记录不属于当前项目或端口不匹配。"
  }
} catch {
  Write-Host "错误：本机进程记录校验失败（$($_.Exception.Message)），未结束任何进程。"
  exit 1
}

$rootProcess = Get-Process -Id $processId -ErrorAction SilentlyContinue
if (-not $rootProcess) {
  Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
  Write-Host "本机服务进程已经退出，已清理过期记录。"
  exit 0
}

try {
  $actualStart = $rootProcess.StartTime.ToUniversalTime()
  if ([Math]::Abs(($actualStart - $recordedStart).TotalSeconds) -gt 5) {
    throw "PID 已被其他进程复用。"
  }
} catch {
  Write-Host "错误：PID $processId 的启动时间与记录不一致，未结束任何进程。"
  exit 1
}

$snapshot = @(Get-CimInstance Win32_Process -ErrorAction Stop)
$rootInfo = $snapshot | Where-Object { [int]$_.ProcessId -eq $processId } | Select-Object -First 1
if (-not $rootInfo -or ([string]$rootInfo.CommandLine -notmatch "npm.*run\s+dev.*$Port")) {
  Write-Host "错误：PID $processId 不是记录的 Novel-Codex-Writer 本机启动进程，未结束任何进程。"
  exit 1
}

function Get-DescendantIds([int]$ParentId, [object[]]$Processes) {
  foreach ($child in ($Processes | Where-Object { [int]$_.ParentProcessId -eq $ParentId })) {
    $childId = [int]$child.ProcessId
    $childId
    Get-DescendantIds $childId $Processes
  }
}

$descendants = @(Get-DescendantIds $processId $snapshot)
$targets = @($descendants + $processId | Sort-Object -Unique -Descending)
foreach ($targetId in $targets) {
  Stop-Process -Id ([int]$targetId) -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 500
if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
  Write-Host "错误：未能结束记录的本机进程树（根 PID $processId）。"
  exit 1
}

Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
$remaining = @(Get-ListeningPids)
if ($remaining.Count -gt 0) {
  Write-Host "本机进程树已结束，但端口 $Port 仍由其他进程占用（PID: $($remaining -join ', ')）。未触碰其他进程。"
} else {
  Write-Host "Novel-Codex-Writer 本机服务已停止。"
}
exit 0
