# 安装 DocMax Word 加载项（直接复制到 Word 的 STARTUP 文件夹，无需管理员权限）
#
# 用法（在项目根目录）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File word-addin\install.ps1
#
# 安装后重启 Word，功能区会出现「DocMax」选项卡：
#   选中文字 → DocMax → AI 改写… / 润色 / 解释
param(
  [switch]$SkipBuild,
  [switch]$NoServer,
  [switch]$NoVerify
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dotm = Join-Path $PSScriptRoot 'build\DocMax.dotm'
$startup = Join-Path $env:APPDATA 'Microsoft\Word\STARTUP'
$target = Join-Path $startup 'DocMax.dotm'

if (-not $SkipBuild) {
  Write-Output '正在构建 Word 加载项…'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build.ps1') -Root $root
  if ($LASTEXITCODE -ne 0) { throw '构建失败，请查看上方错误。' }
}
if (-not (Test-Path $dotm)) { throw "找不到构建产物：$dotm" }

New-Item -ItemType Directory -Force -Path $startup | Out-Null
Copy-Item -Path $dotm -Destination $target -Force
Write-Output "✅ 已安装到 Word STARTUP：$target"

if (-not $NoServer) {
  Write-Output '正在确保 DocMax 本地服务可用…'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\start-docmax.ps1') -NoBrowser
  try {
    $ProgressPreference = 'SilentlyContinue'
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:5199/api/health' -TimeoutSec 4
    if ($health.ok) { Write-Output '✅ DocMax 本地服务运行中：http://127.0.0.1:5199' }
  } catch {
    Write-Output '⚠ 本地服务未启动成功；仍可在 Word 里用「检查服务」按钮启动。'
  }
}

if (-not $NoVerify) {
  Write-Output '正在用隐藏的 Word 实例验证加载项…'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'test.ps1') -Installed
  if ($LASTEXITCODE -ne 0) {
    Write-Output '⚠ 自动验证未通过。请重启 Word 后查看功能区是否有「DocMax」选项卡；若没有，请检查 Word 宏安全设置。'
  }
}

$wordRunning = @(Get-Process WINWORD -ErrorAction SilentlyContinue).Count -gt 0
Write-Output ''
Write-Output '安装完成。使用方式：'
Write-Output '  1. 重启 Word（若正在运行，关闭后重新打开）'
Write-Output '  2. 选中一段文字 → 功能区「DocMax」→「AI 改写…」/「润色」/「解释」'
Write-Output '  3. 修改会先预览；确认后替换，可用 Ctrl+Z 撤销'
if ($wordRunning) { Write-Output ''; Write-Output '注意：检测到 Word 正在运行，需要关闭并重新打开 Word 后加载项才会出现。' }
Write-Output ''
Write-Output '卸载：powershell -NoProfile -ExecutionPolicy Bypass -File word-addin\uninstall.ps1'
