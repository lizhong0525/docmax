' DocMax quick launcher.
' Runs scripts/start-docmax.ps1 hidden (no console window), which starts the
' local server if needed and opens the browser.
Option Explicit

Dim fso, shell, scriptDir, ps1, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(scriptDir, "start-docmax.ps1")

If Not fso.FileExists(ps1) Then
  MsgBox "DocMax launcher not found:" & vbCrLf & ps1, 16, "DocMax"
  WScript.Quit 1
End If

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """"
shell.Run cmd, 0, False
