; DocMax Windows 安装包（NSIS 3，Unicode）
;
; 由 installer\build.ps1 调用，通过 /D 传入 STAGE / OUTFILE / APPICON / ROOT / HAVE_WORDADDIN。
; 安装到当前用户目录（无需管理员），创建桌面/开始菜单快捷方式，可选安装 Word 加载项。

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"

!ifndef STAGE
  !define STAGE "staging"
!endif
!ifndef OUTFILE
  !define OUTFILE "dist\DocMax-Setup.exe"
!endif
!ifndef APPICON
  !define APPICON "..\assets\docmax.ico"
!endif
!ifndef APPNAME
  !define APPNAME "DocMax"
!endif
!ifndef APPVERSION
  !define APPVERSION "0.1.0"
!endif

Unicode true
Name "${APPNAME}"
BrandingText "${APPNAME} ${APPVERSION}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\DocMax"
InstallDirRegKey HKCU "Software\DocMax" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
Icon "${APPICON}"
UninstallIcon "${APPICON}"

VIProductVersion "${APPVERSION}.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "FileDescription" "${APPNAME} 安装程序"
VIAddVersionKey "FileVersion" "${APPVERSION}"
VIAddVersionKey "ProductVersion" "${APPVERSION}"
VIAddVersionKey "LegalCopyright" ""

!define MUI_ICON "${APPICON}"
!define MUI_UNICON "${APPICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\launch-docmax.vbs"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 DocMax"
!define MUI_FINISHPAGE_TEXT "DocMax 已安装完成。$\r$\n$\r$\n· 桌面快捷方式：DocMax（无控制台窗口启动）$\r$\n· Word 加载项：已安装，重启 Word 后功能区出现「DocMax」选项卡$\r$\n· 如需 AI 功能，请确认安装目录 .env 中的 DEEPSEEK_API_KEY$\r$\n$\r$\n安装目录：$INSTDIR"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
Page custom ApiKeyPage ApiKeyPageLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Var ApiKey
Var ApiKeyField
Var ExistingEnv
Var TestMode

Function .onInit
  ReadEnvStr $ApiKey "DOCMAX_API_KEY"
  ReadEnvStr $TestMode "DOCMAX_INSTALL_TEST"
  StrCpy $ExistingEnv ""
FunctionEnd

Function ApiKeyPage
  !insertmacro MUI_HEADER_TEXT "DeepSeek API Key（可选）" "填入后可立即使用 AI 改写；留空也可以稍后编辑安装目录的 .env。"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${If} ${FileExists} "$INSTDIR\.env"
    StrCpy $ExistingEnv "1"
    ${NSD_CreateLabel} 0 0 100% 30u "检测到已有配置 .env，将保留原配置（不会覆盖）。"
  ${Else}
    ${NSD_CreateLabel} 0 0 100% 18u "DeepSeek API Key（可留空）："
  ${EndIf}
  Pop $0

  ${NSD_CreateText} 0 34u 100% 14u "$ApiKey"
  Pop $ApiKeyField

  ${NSD_CreateLabel} 0 56u 100% 32u "获取地址：https://platform.deepseek.com/api_keys$\r$\nAPI Key 只保存在安装目录的 .env 中，不会上传到除 DeepSeek 之外的任何服务。"
  Pop $0

  nsDialogs::Show
FunctionEnd

Function ApiKeyPageLeave
  ${NSD_GetText} $ApiKeyField $ApiKey
FunctionEnd

Section "安装 DocMax" SecInstall
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*.*"

  ; 写入 API Key（不覆盖已有配置）
  ${If} $ExistingEnv != "1"
    ${If} $ApiKey != ""
      FileOpen $0 "$INSTDIR\.env" w
      FileWrite $0 "DEEPSEEK_API_KEY=$ApiKey$\r$\n"
      FileWrite $0 "DEEPSEEK_BASE_URL=https://api.deepseek.com$\r$\n"
      FileWrite $0 "PORT=5199$\r$\n"
      FileWrite $0 "DOCMAX_MODEL=deepseek-flash$\r$\n"
      FileClose $0
    ${EndIf}
  ${EndIf}

  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; 测试安装（自动化）时不改桌面/开始菜单/Word/注册表
  ${If} $TestMode != "1"
    CreateShortCut "$DESKTOP\DocMax.lnk" "$INSTDIR\launch-docmax.vbs" "" "$INSTDIR\assets\docmax.ico" 0
    CreateDirectory "$SMPROGRAMS"
    CreateShortCut "$SMPROGRAMS\DocMax.lnk" "$INSTDIR\launch-docmax.vbs" "" "$INSTDIR\assets\docmax.ico" 0

    ; Word 加载项（仅在检测到 Word 且安装包内包含时）
    SetRegView 64
    ReadRegStr $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\winword.exe" ""
    SetRegView lastused
    ${If} $1 != ""
      CreateDirectory "$APPDATA\Microsoft\Word\STARTUP"
      CopyFiles /SILENT "$INSTDIR\word-addin\DocMax.dotm" "$APPDATA\Microsoft\Word\STARTUP\DocMax.dotm"
    ${EndIf}

    WriteRegStr HKCU "Software\DocMax" "InstallDir" "$INSTDIR"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DocMax" "DisplayName" "DocMax"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DocMax" "DisplayVersion" "${APPVERSION}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DocMax" "Publisher" "DocMax"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DocMax" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DocMax" "DisplayIcon" "$INSTDIR\assets\docmax.ico"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DocMax" "UninstallString" '"$INSTDIR\uninstall.exe"'
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DocMax" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DocMax" "NoModify" 1
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DocMax" "NoRepair" 1
  ${EndIf}
SectionEnd

Section "Uninstall"
  ; 停止已安装的本地服务（只杀安装目录下的 server.mjs 进程，经过辅助脚本以免 NSIS 转义问题）
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\stop-docmax.ps1"'

  ; 备份配置
  CopyFiles /SILENT "$INSTDIR\.env" "$PROFILE\DocMax.env.bak"

  Delete "$DESKTOP\DocMax.lnk"
  Delete "$SMPROGRAMS\DocMax.lnk"
  Delete "$APPDATA\Microsoft\Word\STARTUP\DocMax.dotm"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DocMax"
  DeleteRegKey HKCU "Software\DocMax"

  RMDir /r "$INSTDIR"
SectionEnd
