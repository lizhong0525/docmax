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
  选中文字 → Ctrl/⌘ K（或点「✦ AI 修改」）→ 输入指令 → 审查 diff → 接受。
  支持润色 / 扩写 / 缩写 / 翻译 / 解释，以及 Word 导入。
Word 插件：
  重启 Word 后，功能区会出现「DocMax」选项卡；
  选中文字 → AI 改写… / 润色 / 解释（结果先预览，确认后替换，Ctrl+Z 撤销）。

三、配置 API Key
----------------
安装目录下的 .env 文件：
  DEEPSEEK_API_KEY=sk-...
获取地址：https://platform.deepseek.com/api_keys
修改后重启 DocMax（关闭后台 node 进程或重新登录）即可生效。
没有 Key 也能编辑 Markdown、导入 Word，只是 AI 功能不可用。

四、隐私
--------
· API Key 仅保存在本机 .env，不会上传到除 DeepSeek 之外的任何服务。
· 文档内容只发送给 DeepSeek API；本地服务仅监听 127.0.0.1。
· 卸载时会备份 .env 到 %USERPROFILE%\DocMax.env.bak。

五、卸载
--------
设置 → 应用 → 已安装的应用 → DocMax → 卸载；
或运行安装目录下的 uninstall.ps1。
卸载会删除安装目录与快捷方式，并移除 Word 加载项（重启 Word 后生效）。

六、版本
--------
DocMax 0.1.0
