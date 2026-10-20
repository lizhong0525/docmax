Option Explicit

' ============================================================================
'  DocMax Word 加载项（VBA）
'
'  在 Word 中选中文字 → 功能区「DocMax」→ AI 改写 / 润色 / 解释。
'  改写结果会先在确认框里预览，确认后才替换选区（可用 Ctrl+Z 撤销）。
'
'  依赖：本机运行 DocMax 服务（http://127.0.0.1:5199）。
'  服务未启动时，本加载项会尝试调用项目里的 scripts\start-docmax.ps1 后台启动。
'
'  {{DOCMAX_ROOT}} 会在构建时被替换为本机项目目录。
' ============================================================================

Private Const ADDIN_VERSION As String = "0.3.0"
Private Const DOCMAX_ROOT As String = "{{DOCMAX_ROOT}}"
Private Const API_BASE As String = "http://127.0.0.1:5199"
Private Const API_EDIT As String = API_BASE & "/api/word/edit"
Private Const API_HEALTH As String = API_BASE & "/api/health"
Private Const DEFAULT_MODEL As String = "deepseek-flash"
Private Const DEFAULT_THINKING As String = "off"

#If VBA7 Then
Private Declare PtrSafe Sub DocMaxSleep Lib "kernel32" (ByVal dwMilliseconds As Long)
#Else
Private Declare Sub DocMaxSleep Lib "kernel32" (ByVal dwMilliseconds As Long)
#End If

' ============================================================================
'  Ribbon 回调
' ============================================================================

Public Sub DocMaxRewrite(control As Object)
    Dim instruction As String
    instruction = InputBox("告诉 DocMax 如何修改选中的文字：" & vbCrLf & vbCrLf & _
        "例如：润色、改得更简洁、扩写、翻译成英文……", "DocMax · AI 改写", _
        "润色这段话，保持原意，让表达更简洁专业。")
    If Len(Trim$(instruction)) = 0 Then Exit Sub
    ApplySelectionEdit instruction, "rewrite"
End Sub

Public Sub DocMaxPolish(control As Object)
    ApplySelectionEdit "润色这段文字，保持原意，让表达更简洁、专业、流畅。", "rewrite"
End Sub

Public Sub DocMaxStructure(control As Object)
    ApplySelectionEdit "按照原文的结构重写这段内容；信息不完整或有缺失的地方，用（需补充：…）标注需要补充什么。", "rewrite", "structure-fill"
End Sub

Public Sub DocMaxExplain(control As Object)
    ApplySelectionEdit "解释这段文字的意思、结构和作用，用中文回答，不要修改原文。", "ask"
End Sub

Public Sub DocMaxOpenApp(control As Object)
    On Error GoTo failed
    If Not EnsureServer() Then
        MsgBox "无法连接 DocMax 本地服务，且自动启动失败。" & vbCrLf & vbCrLf & _
            "请先双击桌面上的 DocMax 快捷方式，或运行：" & vbCrLf & _
            DOCMAX_ROOT & "\scripts\start-docmax.ps1", vbExclamation, "DocMax"
        Exit Sub
    End If
    CreateObject("WScript.Shell").Run API_BASE, 1, False
    Exit Sub
failed:
    MsgBox "打开 DocMax 编辑器失败：" & Err.Description, vbExclamation, "DocMax"
End Sub

Public Sub DocMaxHealth(control As Object)
    On Error GoTo failed
    If ServerHealthy() Then
        MsgBox "DocMax 本地服务运行中：" & vbCrLf & API_BASE & vbCrLf & vbCrLf & _
            "加载项版本：" & ADDIN_VERSION, vbInformation, "DocMax"
    Else
        Dim answer As VbMsgBoxResult
        answer = MsgBox("DocMax 本地服务未运行。" & vbCrLf & vbCrLf & "是否现在启动？", _
            vbYesNo + vbQuestion, "DocMax")
        If answer = vbYes Then
            If EnsureServer() Then
                MsgBox "已启动 DocMax 本地服务：" & API_BASE, vbInformation, "DocMax"
            Else
                MsgBox "启动失败。请双击桌面 DocMax 快捷方式，或检查项目依赖是否已安装。", vbExclamation, "DocMax"
            End If
        End If
    End If
    Exit Sub
failed:
    MsgBox "检查服务失败：" & Err.Description, vbExclamation, "DocMax"
End Sub

' ============================================================================
'  主流程：读取选区 → 请求 DocMax → 预览确认 → 替换选区
' ============================================================================

Private Sub ApplySelectionEdit(ByVal instruction As String, ByVal mode As String, Optional ByVal presetId As String = "default")
    On Error GoTo failed

    Dim sel As Range
    Set sel = Selection.Range

    Dim originalRaw As String
    originalRaw = sel.Text
    Dim original As String
    original = NormalizeText(originalRaw)

    If Len(Trim$(original)) = 0 Then
        MsgBox "请先在 Word 中选中要处理的文字。", vbInformation, "DocMax"
        Exit Sub
    End If

    If Not EnsureServer() Then
        MsgBox "无法连接 DocMax 本地服务，请先双击桌面上的 DocMax 快捷方式。", vbExclamation, "DocMax"
        Exit Sub
    End If

    Dim beforeText As String
    Dim afterText As String
    beforeText = NormalizeText(GetBeforeText(sel, 400))
    afterText = NormalizeText(GetAfterText(sel, 400))

    Application.StatusBar = "DocMax：正在请求 DeepSeek…"
    Dim response As String
    response = RequestEdit(original, beforeText, afterText, instruction, mode, presetId)
    Application.StatusBar = False

    If Len(response) = 0 Then
        MsgBox "DocMax 没有响应，请检查本地服务是否正常运行。", vbExclamation, "DocMax"
        Exit Sub
    End If

    If Not JsonGetBool(response, "ok") Then
        MsgBox "DocMax 请求失败：" & vbCrLf & vbCrLf & JsonGetString(response, "error"), vbExclamation, "DocMax"
        Exit Sub
    End If

    If mode = "ask" Then
        ShowLongText "DocMax · 解释", JsonGetString(response, "answer")
        Exit Sub
    End If

    Dim newText As String
    newText = JsonGetString(response, "newText")
    If Len(newText) = 0 Then
        MsgBox "模型没有返回可用的修改结果，请重试或换一种说法。", vbExclamation, "DocMax"
        Exit Sub
    End If

    Dim warningCount As Long
    Dim hasError As Boolean
    Dim truncated As Boolean
    warningCount = JsonGetLong(response, "warningCount")
    hasError = JsonGetBool(response, "hasErrorWarning")
    truncated = JsonGetBool(response, "truncated")

    Dim previewText As String
    previewText = newText
    If Len(previewText) > 900 Then previewText = Left$(previewText, 900) & " …"

    Dim prompt As String
    prompt = "DocMax 建议把选中的 " & Len(original) & " 个字符替换为：" & vbCrLf & vbCrLf & _
        previewText & vbCrLf & vbCrLf
    If warningCount > 0 Then prompt = prompt & "提示：" & warningCount & " 条" & vbCrLf
    If hasError Or truncated Then prompt = prompt & "⚠ 结果可能不完整或存在风险，请核对后再应用。" & vbCrLf
    prompt = prompt & "应用修改？（应用后可用 Ctrl+Z 撤销）"

    If MsgBox(prompt, vbYesNo + vbQuestion, "DocMax · 应用修改") <> vbYes Then Exit Sub

    ' Word 用 vbCr 表示段落；保留选区原有的段落/单元格结束符，避免与下一段粘连
    Dim trailing As String
    If Len(originalRaw) > 0 Then
        If Right$(originalRaw, 2) = vbCrLf Then
            trailing = vbCrLf
        ElseIf Right$(originalRaw, 1) = vbCr Then
            trailing = vbCr
        ElseIf Right$(originalRaw, 1) = Chr$(7) Then
            trailing = Chr$(7)
        End If
    End If

    Dim wordText As String
    wordText = Replace(newText, vbLf, vbCr)
    If Len(trailing) > 0 Then
        If Right$(wordText, Len(trailing)) <> trailing Then wordText = wordText & trailing
    End If

    sel.Text = wordText
    Application.StatusBar = "DocMax：已替换选区（Ctrl+Z 可撤销）"
    Exit Sub

failed:
    Application.StatusBar = False
    MsgBox "DocMax 处理失败：" & Err.Description, vbExclamation, "DocMax"
End Sub

' ============================================================================
'  Word 选区辅助
' ============================================================================

Private Function GetBeforeText(ByVal sel As Range, ByVal maxChars As Long) As String
    Dim docStart As Long
    Dim fromPos As Long
    docStart = ActiveDocument.Content.Start
    fromPos = sel.Start - maxChars
    If fromPos < docStart Then fromPos = docStart
    If fromPos >= sel.Start Then
        GetBeforeText = ""
    Else
        GetBeforeText = ActiveDocument.Range(fromPos, sel.Start).Text
    End If
End Function

Private Function GetAfterText(ByVal sel As Range, ByVal maxChars As Long) As String
    Dim docEnd As Long
    Dim toPos As Long
    docEnd = ActiveDocument.Content.End
    toPos = sel.End + maxChars
    If toPos > docEnd Then toPos = docEnd
    If toPos <= sel.End Then
        GetAfterText = ""
    Else
        GetAfterText = ActiveDocument.Range(sel.End, toPos).Text
    End If
End Function

Private Function NormalizeText(ByVal text As String) As String
    Dim result As String
    result = text
    result = Replace(result, vbCrLf, vbLf)
    result = Replace(result, vbCr, vbLf)
    result = Replace(result, Chr$(11), vbLf)   ' 手动换行
    result = Replace(result, Chr$(7), " ")     ' 单元格结束符
    result = Replace(result, Chr$(12), vbLf)   ' 分页符
    result = Replace(result, Chr$(1), "")      ' 内嵌图片占位
    result = Replace(result, Chr$(2), "")      ' 脚注引用
    NormalizeText = result
End Function

' ============================================================================
'  HTTP / JSON 工具
' ============================================================================

Private Function RequestEdit(ByVal selectionText As String, ByVal beforeText As String, _
    ByVal afterText As String, ByVal instruction As String, ByVal mode As String, _
    ByVal presetId As String) As String

    Dim payload As String
    payload = "{" & _
        Q("instruction") & ":" & JsonQuote(instruction) & "," & _
        Q("mode") & ":" & JsonQuote(mode) & "," & _
        Q("presetId") & ":" & JsonQuote(presetId) & "," & _
        Q("model") & ":" & JsonQuote(DEFAULT_MODEL) & "," & _
        Q("thinking") & ":" & JsonQuote(DEFAULT_THINKING) & "," & _
        Q("docTitle") & ":" & JsonQuote(ActiveDocument.Name) & "," & _
        Q("selection") & ":{" & _
            Q("text") & ":" & JsonQuote(selectionText) & "," & _
            Q("before") & ":" & JsonQuote(beforeText) & "," & _
            Q("after") & ":" & JsonQuote(afterText) & "}}"

    ' 不限制输出长度，给长文生成留足时间（服务端默认超时 10 分钟）
    RequestEdit = HttpPostJson(API_EDIT, payload, 600000)
End Function

Private Function ServerHealthy() As Boolean
    On Error GoTo failed
    Dim http As Object
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    http.Open "GET", API_HEALTH, False
    http.setTimeouts 1500, 1500, 3000, 5000
    http.send
    ServerHealthy = (http.Status = 200)
    Exit Function
failed:
    ServerHealthy = False
End Function

Private Function EnsureServer() As Boolean
    If ServerHealthy() Then
        EnsureServer = True
        Exit Function
    End If
    On Error Resume Next
    Dim shell As Object
    Set shell = CreateObject("WScript.Shell")
    Dim cmd As String
    cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & DOCMAX_ROOT & "\scripts\start-docmax.ps1"" -NoBrowser"
    shell.Run cmd, 0, False
    On Error GoTo 0

    Dim i As Long
    For i = 1 To 40
        DocMaxSleep 500
        If ServerHealthy() Then
            EnsureServer = True
            Exit Function
        End If
    Next i
    EnsureServer = False
End Function

Private Function HttpPostJson(ByVal url As String, ByVal payload As String, ByVal timeoutMs As Long) As String
    On Error GoTo failed
    Dim http As Object
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    http.Open "POST", url, False
    http.setTimeouts 10000, 10000, 30000, timeoutMs
    http.setRequestHeader "Content-Type", "application/json; charset=utf-8"
    http.setRequestHeader "Accept", "application/json"
    http.send Utf8Encode(payload)
    If http.Status = 200 Then
        HttpPostJson = Utf8Decode(http.responseBody)
    Else
        HttpPostJson = Utf8Decode(http.responseBody)
        If Len(HttpPostJson) = 0 Then
            HttpPostJson = "{""ok"":false,""error"":""HTTP " & http.Status & """}"
        End If
    End If
    Exit Function
failed:
    HttpPostJson = ""
End Function

Private Function Utf8Encode(ByVal text As String) As Byte()
    Dim stream As Object
    Set stream = CreateObject("ADODB.Stream")
    stream.Type = 2
    stream.Charset = "utf-8"
    stream.Open
    stream.WriteText text
    stream.Position = 0
    stream.Type = 1
    Utf8Encode = stream.Read
    stream.Close
End Function

Private Function Utf8Decode(ByVal bytes As Variant) As String
    On Error GoTo failed
    Dim stream As Object
    Set stream = CreateObject("ADODB.Stream")
    stream.Type = 1
    stream.Open
    stream.Write bytes
    stream.Position = 0
    stream.Type = 2
    stream.Charset = "utf-8"
    Utf8Decode = stream.ReadText
    stream.Close
    Exit Function
failed:
    Utf8Decode = ""
End Function

Private Function Q(ByVal key As String) As String
    Q = """" & key & """"
End Function

Private Function JsonQuote(ByVal value As String) As String
    JsonQuote = """" & JsonEscape(value) & """"
End Function

Private Function JsonEscape(ByVal value As String) As String
    Dim s As String
    Dim i As Long
    s = value
    ' 去掉除 Tab / 换行以外不可见的控制字符
    For i = 0 To 31
        If i <> 9 And i <> 10 And i <> 13 Then
            s = Replace(s, Chr$(i), "")
        End If
    Next i
    s = Replace(s, "\", "\\")
    s = Replace(s, """", "\""")
    s = Replace(s, vbTab, "\t")
    s = Replace(s, vbCrLf, "\n")
    s = Replace(s, vbCr, "\n")
    s = Replace(s, vbLf, "\n")
    JsonEscape = s
End Function

Private Function FindValuePos(ByVal json As String, ByVal key As String) As Long
    Dim p As Long
    p = InStr(1, json, Q(key), vbTextCompare)
    If p = 0 Then
        FindValuePos = 0
        Exit Function
    End If
    p = InStr(p + Len(key) + 2, json, ":")
    If p = 0 Then
        FindValuePos = 0
        Exit Function
    End If
    p = p + 1
    Do While p <= Len(json)
        Select Case Mid$(json, p, 1)
            Case " ", vbTab, vbCr, vbLf
                p = p + 1
            Case Else
                Exit Do
        End Select
    Loop
    FindValuePos = p
End Function

Private Function JsonGetString(ByVal json As String, ByVal key As String) As String
    Dim p As Long
    Dim i As Long
    Dim ch As String
    Dim out As String
    Dim esc As String
    Dim hexCode As String

    p = FindValuePos(json, key)
    If p = 0 Then
        JsonGetString = ""
        Exit Function
    End If
    If Mid$(json, p, 1) <> """" Then
        JsonGetString = ""
        Exit Function
    End If
    i = p + 1
    Do While i <= Len(json)
        ch = Mid$(json, i, 1)
        If ch = "\" Then
            i = i + 1
            esc = Mid$(json, i, 1)
            Select Case esc
                Case "n": out = out & vbLf
                Case "r": out = out & vbCr
                Case "t": out = out & vbTab
                Case "b": out = out & Chr$(8)
                Case "f": out = out & Chr$(12)
                Case "u"
                    hexCode = Mid$(json, i + 1, 4)
                    out = out & ChrW(CLng("&H" & hexCode))
                    i = i + 4
                Case Else: out = out & esc
            End Select
        ElseIf ch = """" Then
            Exit Do
        Else
            out = out & ch
        End If
        i = i + 1
    Loop
    JsonGetString = out
End Function

Private Function JsonGetLong(ByVal json As String, ByVal key As String) As Long
    Dim p As Long
    Dim i As Long
    Dim ch As String
    Dim digits As String
    Dim sign As Long

    p = FindValuePos(json, key)
    If p = 0 Then
        JsonGetLong = 0
        Exit Function
    End If
    sign = 1
    If Mid$(json, p, 1) = "-" Then
        sign = -1
        p = p + 1
    End If
    i = p
    Do While i <= Len(json)
        ch = Mid$(json, i, 1)
        If ch >= "0" And ch <= "9" Then
            digits = digits & ch
            i = i + 1
        Else
            Exit Do
        End If
    Loop
    If Len(digits) = 0 Then
        JsonGetLong = 0
    Else
        JsonGetLong = sign * CLng(digits)
    End If
End Function

Private Function JsonGetBool(ByVal json As String, ByVal key As String) As Boolean
    Dim p As Long
    p = FindValuePos(json, key)
    If p = 0 Then
        JsonGetBool = False
    Else
        JsonGetBool = (LCase$(Mid$(json, p, 4)) = "true")
    End If
End Function

Private Sub ShowLongText(ByVal title As String, ByVal text As String)
    Dim body As String
    body = text
    If Len(body) > 4000 Then body = Left$(body, 4000) & vbCrLf & "……（已截断）"
    If Len(body) = 0 Then body = "（模型没有返回内容）"
    MsgBox body, vbInformation, title
End Sub

' ============================================================================
'  自动化自检（构建/安装脚本调用，不需要打开文档）
' ============================================================================

Public Sub DocMaxSelfTest()
    Dim outPath As String
    Dim result As String
    On Error GoTo failed

    outPath = Environ$("TEMP") & "\docmax-word-selftest.txt"
    If Not EnsureServer() Then
        result = "FAIL|server-unavailable"
        WriteUtf8File outPath, result
        Exit Sub
    End If

    Dim response As String
    response = HttpPostJson(API_EDIT, TestPayload(), 180000)
    If Len(response) = 0 Then
        result = "FAIL|empty-response"
    ElseIf JsonGetBool(response, "ok") Then
        result = "SELFTEST_OK" & vbLf & _
            "newText=" & JsonGetString(response, "newText") & vbLf & _
            "warnings=" & JsonGetLong(response, "warningCount") & vbLf & _
            "latencyMs=" & JsonGetLong(response, "latencyMs") & vbLf & _
            "model=" & JsonGetString(response, "model")
    Else
        result = "FAIL|" & JsonGetString(response, "error")
    End If
    WriteUtf8File outPath, result
    Exit Sub

failed:
    WriteUtf8File outPath, "FAIL|" & Err.Number & "|" & Err.Description
End Sub

Private Function TestPayload() As String
    Dim selectionText As String
    Dim beforeText As String
    Dim afterText As String
    selectionText = "这个功能目前有一个问题，就是当用户点击按钮以后页面会一直卡住不动，我们需要尽快修复它。"
    beforeText = "## 已知问题" & vbLf & vbLf
    afterText = vbLf & vbLf & "## 下一步"
    TestPayload = "{" & _
        Q("instruction") & ":" & JsonQuote("润色这句话，使其更简洁专业，保持原意。") & "," & _
        Q("mode") & ":" & JsonQuote("rewrite") & "," & _
        Q("selection") & ":{" & _
            Q("text") & ":" & JsonQuote(selectionText) & "," & _
            Q("before") & ":" & JsonQuote(beforeText) & "," & _
            Q("after") & ":" & JsonQuote(afterText) & "}}"
End Function

' 文档级自检：在隐藏的临时文档里选中一段文字 → 请求 DocMax → 替换选区 → 检查结果
Public Sub DocMaxSelfTestDocument()
    Dim outPath As String
    Dim result As String
    Dim d As Document
    On Error GoTo failed

    outPath = Environ$("TEMP") & "\docmax-word-selftest-doc.txt"
    If Not EnsureServer() Then
        WriteUtf8File outPath, "FAIL|server-unavailable"
        Exit Sub
    End If

    Set d = Documents.Add()
    Dim original As String
    original = "这个功能目前有一个问题，就是当用户点击按钮以后页面会一直卡住不动，我们需要尽快修复它。"
    d.Content.Text = original & vbCr

    Dim sel As Range
    Set sel = d.Range
    sel.SetRange 0, Len(original)
    sel.Select

    Dim beforeText As String
    Dim afterText As String
    beforeText = NormalizeText(d.Range(0, sel.Start).Text)
    afterText = NormalizeText(d.Range(sel.End, d.Content.End).Text)

    Dim response As String
    response = RequestEdit(original, beforeText, afterText, "润色这句话，使其更简洁专业，保持原意。", "rewrite")

    If Len(response) = 0 Then
        result = "FAIL|empty-response"
    ElseIf Not JsonGetBool(response, "ok") Then
        result = "FAIL|" & JsonGetString(response, "error")
    Else
        Dim newText As String
        newText = JsonGetString(response, "newText")
        If Len(newText) = 0 Then
            result = "FAIL|empty-newtext"
        Else
            sel.Text = Replace(newText, vbLf, vbCr)
            Dim updated As String
            updated = NormalizeText(d.Content.Text)
            result = "DOC_SELFTEST_OK" & vbLf & "after=" & updated & vbLf & "original=" & original
        End If
    End If

    d.Close(0)
    WriteUtf8File outPath, result
    Exit Sub

failed:
    If Not d Is Nothing Then d.Close(0)
    WriteUtf8File outPath, "FAIL|" & Err.Number & "|" & Err.Description
End Sub

Private Sub WriteUtf8File(ByVal path As String, ByVal text As String)
    On Error Resume Next
    Dim stream As Object
    Set stream = CreateObject("ADODB.Stream")
    stream.Type = 2
    stream.Charset = "utf-8"
    stream.Open
    stream.WriteText text
    stream.SaveToFile path, 2
    stream.Close
End Sub
