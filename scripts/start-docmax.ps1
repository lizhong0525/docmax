# DocMax 桌面快速启动
# 双击后：若本地服务未运行则后台启动（优先生产模式），然后打开浏览器。
# 直接运行（不打开浏览器，便于调试）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-docmax.ps1 -NoBrowser
param(
  [int]$Port = 5199,
  [switch]$NoBrowser
)

# 自动化测试用：设置 DOCMAX_NO_BROWSER=1 时不自动打开浏览器
if ($env:DOCMAX_NO_BROWSER -eq '1') { $NoBrowser = $true }

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$url = "http://127.0.0.1:$Port"
$devDir = Join-Path $root '.dev'
$logPath = Join-Path $devDir 'server.log'
$errPath = Join-Path $devDir 'server.err.log'
$pidPath = Join-Path $devDir 'server.pid'

function Show-Error([string]$message, [string]$detail = '') {
  $text = $message
  if ($detail) { $text = "$message`n`n$detail" }
  try {
    Add-Type -AssemblyName PresentationFramework -ErrorAction Stop
    [System.Windows.MessageBox]::Show($text, 'DocMax 启动失败', 'OK', 'Error') | Out-Null
  } catch {
    Write-Error $text
  }
}

function Test-DocMax {
  try {
    $resp = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 2
    return ($null -ne $resp -and $resp.ok -eq $true)
  } catch {
    return $false
  }
}

function Test-PortInUse {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $task = $client.ConnectAsync('127.0.0.1', $Port)
    $ok = $task.Wait(600)
    $client.Close()
    return $ok
  } catch {
    return $false
  }
}

# 1) 已经在运行：直接打开浏览器
if (Test-DocMax) {
  if (-not $NoBrowser) { Start-Process $url }
  exit 0
}

if (Test-PortInUse) {
  Show-Error "端口 $Port 已被其他程序占用，DocMax 无法启动。" "请关闭占用该端口的程序，或设置环境变量 PORT 后重新创建快捷方式。"
  exit 1
}

# 2) 检查运行环境
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) {
  foreach ($candidate in @(
      (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    )) {
    if (Test-Path $candidate) { $node = $candidate; break }
  }
}
if (-not $node) {
  Show-Error '未找到 Node.js。' '请安装 Node.js 22 或更高版本（https://nodejs.org），然后重试。'
  exit 1
}

$tsx = Join-Path $root 'node_modules\tsx\dist\cli.mjs'
if (-not (Test-Path $tsx)) {
  Show-Error '依赖尚未安装。' "请先在项目目录运行：pnpm install（或 npm install）`n`n目录：$root"
  exit 1
}

# 3) 后台启动服务（优先生产构建，缺失则开发模式）
New-Item -ItemType Directory -Force -Path $devDir | Out-Null
$serverArgs = @($tsx, (Join-Path $root 'server\index.ts'), '--prod')
$mode = 'production'
if (-not (Test-Path (Join-Path $root 'dist\index.html'))) {
  $serverArgs = @($tsx, (Join-Path $root 'server\index.ts'), '--dev')
  $mode = 'development'
}

$env:PORT = "$Port"
$process = Start-Process -FilePath $node -ArgumentList $serverArgs -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput $logPath -RedirectStandardError $errPath -PassThru

# 4) 等待服务就绪（最多约 45 秒）
$ready = $false
for ($i = 0; $i -lt 90; $i++) {
  Start-Sleep -Milliseconds 500
  if ($process.HasExited) { break }
  if (Test-DocMax) { $ready = $true; break }
}

if (-not $ready) {
  $detail = "模式：$mode`n日志：$logPath"
  if (Test-Path $errPath) {
    $tail = (Get-Content $errPath -Tail 8 -ErrorAction SilentlyContinue) -join "`n"
    if ($tail) { $detail = "$detail`n`n$tail" }
  }
  Show-Error 'DocMax 本地服务启动失败。' $detail
  exit 1
}

$process.Id | Set-Content -LiteralPath $pidPath -Encoding ASCII
if (-not $NoBrowser) { Start-Process $url }
exit 0
