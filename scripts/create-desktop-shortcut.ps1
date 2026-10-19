# 在桌面创建 DocMax 快速启动快捷方式（Windows）。
#
# 用法（在项目根目录）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\create-desktop-shortcut.ps1
#
# 行为：快捷方式指向 scripts\launch-docmax.vbs（无控制台窗口）→
#       运行 scripts\start-docmax.ps1：服务未启动则后台启动，然后打开浏览器。
param(
  [string]$Name = 'DocMax',
  [switch]$OpenFolder
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $root 'scripts\launch-docmax.vbs'
$icon = Join-Path $root 'assets\docmax.ico'
$desktop = [Environment]::GetFolderPath('Desktop')

if (-not (Test-Path $vbs)) { throw "找不到启动器：$vbs" }
if (-not (Test-Path $icon)) { throw "找不到图标：$icon（可运行 python scripts/make-icon.py 生成）" }

$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$lnkPath = Join-Path $desktop "$Name.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
$shortcut.TargetPath = $wscript
$shortcut.Arguments = '"' + $vbs + '"'
$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = "$icon,0"
$shortcut.Description = 'DocMax · 极简 Markdown 编辑器（启动本地服务并打开浏览器）'
$shortcut.WindowStyle = 1
$shortcut.Save()

# 刷新桌面（让图标立即出现）
try {
  $signature = @'
[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);
'@
  Add-Type -MemberDefinition $signature -Name Shell32 -Namespace Win32 -ErrorAction Stop
  [Win32.Shell32]::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero)
} catch {
  # 刷新失败不影响快捷方式创建
}

Write-Output "✅ 已创建桌面快捷方式：$lnkPath"
Write-Output "   目标：$wscript $vbs"
Write-Output "   图标：$icon"
Write-Output ''
Write-Output '双击「DocMax」即可启动：服务已在运行则直接打开浏览器，否则后台启动后再打开。'
Write-Output '停止服务：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-docmax.ps1'

if ($OpenFolder) {
  Start-Process explorer.exe -ArgumentList "/select,`"$lnkPath`""
}
