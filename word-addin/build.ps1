# 构建 DocMax Word 加载项（.dotm）
#
# 做什么：
#   1. 用 Word COM 创建一个隐藏的空白文档，写入 VBA 模块（DocMax.bas，替换项目路径占位符）
#   2. 保存为启用宏的 Word 模板（.dotm）
#   3. 向 OOXML 包注入自定义功能区 customUI（DocMax 选项卡）
#   4. 需要临时打开「信任对 VBA 工程对象模型的访问」，构建后恢复原值
#
# 要求：本机安装 Word（Microsoft 365 / Office 2016+），PowerShell 5.1+。
param(
  [string]$Root,
  [string]$Output
)

$ErrorActionPreference = 'Stop'

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$srcDir = Join-Path $PSScriptRoot 'src'
$codePath = Join-Path $srcDir 'DocMax.bas'
$customUiPath = Join-Path $srcDir 'customUI.xml'
if (-not $Output) { $Output = Join-Path $PSScriptRoot 'build\DocMax.dotm' }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Output) | Out-Null

if (-not (Test-Path $codePath)) { throw "找不到 VBA 源码：$codePath" }
if (-not (Test-Path $customUiPath)) { throw "找不到功能区定义：$customUiPath" }

$code = [System.IO.File]::ReadAllText($codePath, [System.Text.Encoding]::UTF8)
if (-not $code.Contains('{{DOCMAX_ROOT}}')) { throw 'DocMax.bas 缺少 {{DOCMAX_ROOT}} 占位符' }
$code = $code.Replace('{{DOCMAX_ROOT}}', $Root)

$wordExe = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\winword.exe' -ErrorAction SilentlyContinue
if (-not $wordExe) { throw '未检测到 Microsoft Word，无法构建加载项。' }

# 临时允许以编程方式访问 VBA 工程（构建后恢复）
$securityKey = 'HKCU:\Software\Microsoft\Office\16.0\Word\Security'
$hadAccess = $false
$oldAccess = $null
if (Test-Path $securityKey) {
  $prop = Get-ItemProperty -Path $securityKey -Name AccessVBOM -ErrorAction SilentlyContinue
  if ($null -ne $prop -and $null -ne $prop.AccessVBOM) {
    $hadAccess = $true
    $oldAccess = $prop.AccessVBOM
  }
}
New-Item -Path $securityKey -Force | Out-Null
Set-ItemProperty -Path $securityKey -Name AccessVBOM -Value 1 -Type DWord

$word = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0

  $doc = $word.Documents.Add()
  $components = $doc.VBProject.VBComponents
  $module = $components.Add(1)   # vbext_ct_StdModule
  $module.Name = 'DocMax'
  $module.CodeModule.AddFromString($code)

  if (Test-Path $Output) { Remove-Item -Path $Output -Force }
  $doc.SaveAs2($Output, 15)      # wdFormatXMLTemplateMacroEnabled
  $doc.Close(0)
  Write-Output "已生成 VBA 模板：$Output"

  # 注入 customUI
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem

  $customUi = [System.IO.File]::ReadAllText($customUiPath, [System.Text.Encoding]::UTF8)
  [xml]$null = $customUi   # 先验证 XML 合法

  $zip = [System.IO.Compression.ZipFile]::Open($Output, [System.IO.Compression.ZipArchiveMode]::Update)
  try {
    function Get-ZipText([System.IO.Compression.ZipArchive]$archive, [string]$name) {
      $entry = $archive.GetEntry($name)
      if (-not $entry) { return $null }
      $reader = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8)
      try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
    }
    function Set-ZipText([System.IO.Compression.ZipArchive]$archive, [string]$name, [string]$text) {
      $entry = $archive.GetEntry($name)
      if ($entry) { $entry.Delete() }
      $entry = $archive.CreateEntry($name)
      $writer = New-Object System.IO.StreamWriter($entry.Open(), (New-Object System.Text.UTF8Encoding($false)))
      try { $writer.Write($text) } finally { $writer.Dispose() }
    }

    Set-ZipText $zip 'customUI/customUI.xml' $customUi

    $rels = Get-ZipText $zip '_rels/.rels'
    if ($null -eq $rels) { throw 'OOXML 包缺少 _rels/.rels' }
    if ($rels -notmatch 'customUI/customUI\.xml') {
      $relation = '<Relationship Id="rIdDocMaxCustomUI" Type="http://schemas.microsoft.com/office/2006/relationships/ui/extensibility" Target="customUI/customUI.xml"/>'
      $rels = $rels -replace '</Relationships>', ($relation + '</Relationships>')
      Set-ZipText $zip '_rels/.rels' $rels
    }

    $contentTypes = Get-ZipText $zip '[Content_Types].xml'
    if ($null -eq $contentTypes) { throw 'OOXML 包缺少 [Content_Types].xml' }
    if ($contentTypes -notmatch 'customUI/customUI\.xml') {
      $override = '<Override PartName="/customUI/customUI.xml" ContentType="application/xml"/>'
      $contentTypes = $contentTypes -replace '</Types>', ($override + '</Types>')
      Set-ZipText $zip '[Content_Types].xml' $contentTypes
    }
  } finally {
    $zip.Dispose()
  }

  $size = (Get-Item $Output).Length
  Write-Output "已注入功能区 customUI（DocMax 选项卡）"
  Write-Output ("✅ 构建完成：" + $Output + " (" + [math]::Round($size / 1KB, 1) + " KB)")
} finally {
  if ($word) {
    try { $word.Quit() } catch { }
    try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null } catch { }
  }
  if ($hadAccess) {
    Set-ItemProperty -Path $securityKey -Name AccessVBOM -Value $oldAccess -Type DWord
  } else {
    Remove-ItemProperty -Path $securityKey -Name AccessVBOM -ErrorAction SilentlyContinue
  }
}
