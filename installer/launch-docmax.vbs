' DocMax installed launcher.
' Starts the bundled local server if it is not running, then opens the browser.
' Usage: wscript.exe launch-docmax.vbs [/nobrowser]
Option Explicit

Dim fso, shell, baseDir, nodeExe, serverMjs, logFile, url, noBrowser, i
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = fso.BuildPath(baseDir, "node.exe")
serverMjs = fso.BuildPath(baseDir, "server.mjs")
logFile = fso.BuildPath(baseDir, "docmax.log")
url = "http://127.0.0.1:5199"

If Not fso.FileExists(nodeExe) Then
  MsgBox "DocMax is not installed correctly: node.exe not found." & vbCrLf & baseDir, 16, "DocMax"
  WScript.Quit 1
End If
If Not fso.FileExists(serverMjs) Then
  MsgBox "DocMax is not installed correctly: server.mjs not found." & vbCrLf & baseDir, 16, "DocMax"
  WScript.Quit 1
End If

noBrowser = False
For i = 0 To WScript.Arguments.Count - 1
  If LCase(WScript.Arguments(i)) = "/nobrowser" Or LCase(WScript.Arguments(i)) = "nobrowser" Then noBrowser = True
Next

If Not IsHealthy() Then
  Dim env
  Set env = shell.Environment("Process")
  env("DOCMAX_ROOT") = baseDir

  Dim inner, cmd
  inner = Chr(34) & nodeExe & Chr(34) & " " & Chr(34) & serverMjs & Chr(34) & " --prod >> " & Chr(34) & logFile & Chr(34) & " 2>&1"
  cmd = "cmd.exe /c " & Chr(34) & inner & Chr(34)
  shell.CurrentDirectory = baseDir
  shell.Run cmd, 0, False

  Dim waited
  waited = 0
  Do While Not IsHealthy()
    WScript.Sleep 500
    waited = waited + 500
    If waited >= 60000 Then
      MsgBox "DocMax local server failed to start." & vbCrLf & vbCrLf & _
        "Please check the log:" & vbCrLf & logFile, 16, "DocMax"
      WScript.Quit 1
    End If
  Loop
End If

If Not noBrowser Then shell.Run url, 1, False

Function IsHealthy()
  On Error Resume Next
  Dim http
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.Open "GET", url & "/api/health", False
  http.setTimeouts 1000, 1000, 2000, 3000
  http.send
  If Err.Number = 0 Then
    IsHealthy = (http.Status = 200)
  Else
    IsHealthy = False
  End If
  Err.Clear
  On Error GoTo 0
End Function
