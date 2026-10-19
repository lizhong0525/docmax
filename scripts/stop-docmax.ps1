# 停止由桌面快捷方式启动的 DocMax 本地服务。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-docmax.ps1
param(
  [int]$Port = 5199
)

$root = Split-Path -Parent $PSScriptRoot
$pidPath = Join-Path $root '.dev\server.pid'
$stopped = $false

function Get-DocMaxProcesses {
  $result = @()
  foreach ($p in @(Get-Process -Name node -ErrorAction SilentlyContinue)) {
    $info = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.Id)" -ErrorAction SilentlyContinue
    if ($info -and $info.CommandLine -and $info.CommandLine -match 'server[\\/]index\.ts') { $result += $p }
  }
  return $result
}

if (Test-Path $pidPath) {
  $savedPid = (Get-Content -LiteralPath $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($savedPid -and $savedPid -match '^\d+$') {
    $proc = Get-Process -Id ([int]$savedPid) -ErrorAction SilentlyContinue
    if ($proc) {
      $info = Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.Id)" -ErrorAction SilentlyContinue
      if ($info -and $info.CommandLine -and $info.CommandLine -match 'server[\\/]index\.ts') {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        $stopped = $true
        Write-Output "已停止 DocMax 服务（PID $($proc.Id)）。"
      }
    }
  }
  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}

if (-not $stopped) {
  $procs = Get-DocMaxProcesses
  foreach ($p in $procs) {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    $stopped = $true
    Write-Output "已停止 DocMax 服务（PID $($p.Id)）。"
  }
}

if (-not $stopped) {
  Write-Output "DocMax 当前没有在运行。"
  exit 0
}

Start-Sleep -Milliseconds 500
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Write-Output "警告：端口 $Port 仍在监听，可能被其他程序占用。"
  exit 1
}
Write-Output "端口 $Port 已释放。"
exit 0
