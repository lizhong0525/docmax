DocMax —— 极简 Markdown 编辑器 + DeepSeek 选区 AI + Word 加载项
================================================================

感谢安装 DocMax。

一、怎么打开
------------
· 双击桌面上的「DocMax」快捷方式（或开始菜单里的 DocMax）。
· 第一次启动会在后台运行本地服务，然后自动打开浏览器：
  http://127.0.0.1:5199
· 服务日志：安装目录下的 docmax.log

二、使用
--------
浏览器编辑器：
  · 顶栏「新建」：新建空白文档；「文档」：文档库（打开/切换/重命名/删除）。
  · 每篇文档自动保存到「文档\DocMax\docs\<文档id>\」，内容、历史版本、留痕分开存放。
  · 选中文字 → Ctrl/⌘ K（或点「✦ AI 修改」）→ 输入指令或选「提示词模式」→ 审查 diff → 接受。
  · 顶栏「审阅」：查看 AI 提案/接受/拒绝、每次保存、版本 diff，可一键回滚；删除的文档进 trash/。
Word 插件：
  重启 Word 后，功能区会出现「DocMax」选项卡；
  选中文字 → AI 改写… / 结构重写 / 润色 / 解释（结果先预览，确认后替换，Ctrl+Z 撤销）。

三、数据放在哪
--------------
文档库默认：%USERPROFILE%\Documents\DocMax
  docs\<文档id>\document.md      当前内容
  docs\<文档id>\revisions\       每次内容变化的版本快照
  docs\<文档id>\audit.jsonl      全程留痕（AI 提案/接受/拒绝/保存/回滚…）
  trash\                         删除的文档（保留版本与留痕）
备份整个「文档\DocMax」文件夹即可带走全部文档与历史。

四、配置 API Key
----------------
安装目录下的 .env 文件：
  DEEPSEEK_API_KEY=sk-...
获取地址：https://platform.deepseek.com/api_keys
修改后重启 DocMax（关闭后台 node 进程或重新登录）即可生效。
没有 Key 也能编辑 Markdown、导入 Word，只是 AI 功能不可用。

五、隐私
--------
· API Key 仅保存在本机 .env，不会上传到除 DeepSeek 之外的任何服务。
· 文档内容只发送给 DeepSeek API；本地服务仅监听 127.0.0.1。
· 文档库只写本机「文档\DocMax」，不经过网络。
· 卸载时会备份 .env 到 %USERPROFILE%\DocMax.env.bak；文档库不会被删除。

六、卸载
--------
设置 → 应用 → 已安装的应用 → DocMax → 卸载；
或运行安装目录下的 uninstall.exe。
卸载会删除安装目录与快捷方式，并移除 Word 加载项（重启 Word 后生效）。
文档库（「文档\DocMax」）会保留，需要时可手动备份/删除。

七、版本
--------
DocMax 0.4.0
