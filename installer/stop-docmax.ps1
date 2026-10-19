# 停止由安装版 DocMax 启动的本地服务（卸载时调用）
$ErrorActionPreference = 'SilentlyContinue'
$dir = $PSScriptRoot
$escaped = [regex]::Escape($dir)
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -match $escaped -and $_.CommandLine -match 'server\.mjs' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
