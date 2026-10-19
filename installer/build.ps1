# 构建 DocMax Windows 安装包（NSIS）
#
# 产物：installer\dist\DocMax-Setup.exe（自包含，内置 Node 运行时，无需另装 Node）
#
# 流程：
#   1. 构建前端 dist/ 与 Word 加载项 .dotm（如缺失）
#   2. 用 esbuild 把服务端打包成单个 server.mjs（不再需要 node_modules）
#   3. 组装 staging：node.exe + server.mjs + dist + Word 加载项 + 启动器 + 说明
#   4. 用 NSIS 编译成安装包（首次构建会自动下载便携版 NSIS 到 installer\tools）
param(
  [string]$NodePath,
  [string]$Makensis,
  [switch]$SkipWordAddin
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$installerDir = $PSScriptRoot
$stage = Join-Path $installerDir 'staging'
$distDir = Join-Path $installerDir 'dist'
$toolsDir = Join-Path $installerDir 'tools'
$outExe = Join-Path $distDir 'DocMax-Setup.exe'
$packageJson = [System.IO.File]::ReadAllText((Join-Path $root 'package.json'), [System.Text.Encoding]::UTF8); $version = ($packageJson | ConvertFrom-Json).version

function Get-NodeExe {
  if ($NodePath -and (Test-Path $NodePath)) { return (Resolve-Path $NodePath).Path }
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw '未找到 node.exe，请先安装 Node.js 或通过 -NodePath 指定。'
}

function Get-MakensisExe {
  if ($Makensis -and (Test-Path $Makensis)) { return (Resolve-Path $Makensis).Path }
  $candidates = @(
    (Join-Path $toolsDir 'nsis\makensis.exe'),
    'C:\Program Files (x86)\NSIS\makensis.exe',
    'C:\Program Files\NSIS\makensis.exe'
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  $cmd = Get-Command makensis.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  # 下载便携版 NSIS（SourceForge）
  New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
  $zip = Join-Path $toolsDir 'nsis-3.11.zip'
  if (-not (Test-Path $zip)) {
    Write-Output '首次构建：下载 NSIS 便携版…'
    $url = 'https://sourceforge.net/projects/nsis/files/NSIS%203/3.11/nsis-3.11.zip/download'
    & curl.exe -L --fail --max-time 180 -o $zip $url
    if ($LASTEXITCODE -ne 0) { throw '下载 NSIS 失败，请手动安装 NSIS 后用 -Makensis 指定 makensis.exe。' }
  }
  $extractDir = Join-Path $toolsDir 'nsis'
  if (Test-Path $extractDir) { Remove-Item -Path $extractDir -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $extractDir -Force
  $found = Get-ChildItem -Path $extractDir -Recurse -Filter makensis.exe | Select-Object -First 1
  if (-not $found) { throw 'NSIS 解压后未找到 makensis.exe。' }
  return $found.FullName
}

try {
  $node = Get-NodeExe
  $esbuild = Join-Path $root 'node_modules\esbuild\bin\esbuild'
  if (-not (Test-Path $esbuild)) { throw '缺少 esbuild，请先运行 pnpm install。' }

  # 1) 前端构建
  Write-Output '构建前端…'
  & $node (Join-Path $root 'node_modules\vite\bin\vite.js') build | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '前端构建失败。' }

  # 2) Word 加载项
  $dotm = Join-Path $root 'word-addin\build\DocMax.dotm'
  if (-not $SkipWordAddin -and -not (Test-Path $dotm)) {
    Write-Output '构建 Word 加载项…'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'word-addin\build.ps1') -Root $root
    if ($LASTEXITCODE -ne 0) { throw 'Word 加载项构建失败。' }
  }

  # 3) 服务端单文件打包
  Write-Output '打包服务端…'
  if (Test-Path $stage) { Remove-Item -Path $stage -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  $serverOut = Join-Path $stage 'server.mjs'
  # CJS 依赖（express/mammoth 等）在 ESM 产物里需要 createRequire 才能动态 require 内置模块
  $banner = "import { createRequire as __docmaxCreateRequire } from 'node:module'; const require = __docmaxCreateRequire(import.meta.url);"
  & $node $esbuild (Join-Path $root 'server\index.ts') --bundle --platform=node --format=esm --target=node22 `
    --external:vite "--banner:js=$banner" --outfile=$serverOut --log-level=warning
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $serverOut)) { throw '服务端打包失败。' }

  # 4) 组装 staging
  Copy-Item -Path (Join-Path $root 'dist') -Destination (Join-Path $stage 'dist') -Recurse
  Copy-Item -Path $node -Destination (Join-Path $stage 'node.exe')
  $nodeDir = Split-Path -Parent $node
  foreach ($licenseName in @('LICENSE', 'LICENSE.md', 'LICENSE.txt')) {
    $licensePath = Join-Path $nodeDir $licenseName
    if (Test-Path $licensePath) {
      Copy-Item -Path $licensePath -Destination (Join-Path $stage 'NODE-LICENSE.txt')
      break
    }
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $stage 'assets') | Out-Null
  Copy-Item -Path (Join-Path $root 'assets\docmax.ico') -Destination (Join-Path $stage 'assets\docmax.ico')
  Copy-Item -Path (Join-Path $installerDir 'launch-docmax.vbs') -Destination (Join-Path $stage 'launch-docmax.vbs')
  Copy-Item -Path (Join-Path $installerDir 'README.txt') -Destination (Join-Path $stage 'README.txt')
  Copy-Item -Path (Join-Path $installerDir 'stop-docmax.ps1') -Destination (Join-Path $stage 'stop-docmax.ps1')
  if (Test-Path $dotm) {
    New-Item -ItemType Directory -Force -Path (Join-Path $stage 'word-addin') | Out-Null
    Copy-Item -Path $dotm -Destination (Join-Path $stage 'word-addin\DocMax.dotm')
  }

  # 5) NSIS 编译
  $makensisExe = Get-MakensisExe
  New-Item -ItemType Directory -Force -Path $distDir | Out-Null
  if (Test-Path $outExe) { Remove-Item -Path $outExe -Force }
  $defineWord = ''
  if (Test-Path (Join-Path $stage 'word-addin\DocMax.dotm')) { $defineWord = '/DHAVE_WORDADDIN=1' }
  Write-Output '编译安装包（压缩 Node 运行时，可能需要 1–3 分钟）…'
  $args = @(
    '/V2',
    "/DSTAGE=$stage",
    "/DOUTFILE=$outExe",
    "/DAPPICON=$(Join-Path $root 'assets\docmax.ico')",
    "/DAPPVERSION=$version",
    $defineWord,
    (Join-Path $installerDir 'docmax.nsi')
  ) | Where-Object { $_ }
  & $makensisExe @args
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $outExe)) { throw 'NSIS 编译失败。' }

  $sizeMb = [math]::Round((Get-Item $outExe).Length / 1MB, 1)
  Write-Output ''
  Write-Output ("✅ 安装包已生成：" + $outExe + " (" + $sizeMb + " MB)")
  Write-Output ("   staging：" + $stage)
} catch {
  Write-Output ("❌ 构建失败：" + $_.Exception.Message)
  exit 1
}
