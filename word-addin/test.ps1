# 测试 DocMax Word 加载项
#
# 用隐藏的 Word 实例运行 VBA 自检宏（不弹窗、不改用户文档）：
#   DocMaxSelfTest          → 只测 HTTP/API 链路
#   DocMaxSelfTestDocument  → 在隐藏临时文档里选中文字、请求、替换选区，验证完整链路
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File word-addin\test.ps1            # 测试构建产物
#   powershell -NoProfile -ExecutionPolicy Bypass -File word-addin\test.ps1 -Installed # 测试已安装到 STARTUP 的加载项
param(
  [string]$DotmPath,
  [switch]$Installed
)

$ErrorActionPreference = 'Stop'
$resultPath = Join-Path $env:TEMP 'docmax-word-selftest.txt'
$docResultPath = Join-Path $env:TEMP 'docmax-word-selftest-doc.txt'
if (Test-Path $resultPath) { Remove-Item $resultPath -Force }
if (Test-Path $docResultPath) { Remove-Item $docResultPath -Force }

if ($Installed) {
  # 不打开任何文档，只启动 Word，验证 STARTUP 里的全局模板已被加载
  $DotmPath = $null
} elseif (-not $DotmPath) {
  $DotmPath = Join-Path $PSScriptRoot 'build\DocMax.dotm'
}
if ($DotmPath -and -not (Test-Path $DotmPath)) { throw "找不到加载项：$DotmPath" }

$word = $null
$doc = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $word.AutomationSecurity = 1   # msoAutomationSecurityLow：自动化时允许宏

  if ($DotmPath) {
    $doc = $word.Documents.Open($DotmPath)
  }

  $word.Run('DocMaxSelfTest')
  $word.Run('DocMaxSelfTestDocument')

  $deadline = (Get-Date).AddSeconds(60)
  while ((-not (Test-Path $resultPath) -or -not (Test-Path $docResultPath)) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 300
  }
  if ($doc) { $doc.Close(0) }
} finally {
  if ($word) {
    try { $word.Quit() } catch { }
    try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null } catch { }
  }
}

if (-not (Test-Path $resultPath)) {
  Write-Output '❌ 自检失败：没有生成结果文件（Word 宏可能未加载或被安全策略阻止）'
  exit 1
}

$result = Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8
Write-Output '--- Word 加载项自检（API） ---'
Write-Output $result.Trim()

$docResult = if (Test-Path $docResultPath) { Get-Content -LiteralPath $docResultPath -Raw -Encoding UTF8 } else { '' }
Write-Output '--- Word 加载项自检（文档内选中 → 替换） ---'
if ($docResult) { Write-Output $docResult.Trim() } else { Write-Output '（未生成文档自检结果）' }

$ok = ($result -match '^SELFTEST_OK') -and ($docResult -match '^DOC_SELFTEST_OK')
if ($ok) {
  Write-Output '✅ Word 加载项自检通过'
  exit 0
} else {
  Write-Output '❌ Word 加载项自检失败'
  exit 1
}
