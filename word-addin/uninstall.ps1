# 卸载 DocMax Word 加载项（从 STARTUP 删除模板）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File word-addin\uninstall.ps1
$ErrorActionPreference = 'Stop'
$startup = Join-Path $env:APPDATA 'Microsoft\Word\STARTUP'
$target = Join-Path $startup 'DocMax.dotm'

if (Test-Path $target) {
  Remove-Item -Path $target -Force
  Write-Output "✅ 已移除：$target"
} else {
  Write-Output "未找到已安装的加载项：$target"
}

$wordRunning = @(Get-Process WINWORD -ErrorAction SilentlyContinue).Count -gt 0
if ($wordRunning) { Write-Output '请重启 Word 后生效。' }
