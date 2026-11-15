# 微光翻译 Glimmer

一款 Chrome 沉浸式双语翻译扩展（Manifest V3）。网页段落下方直接插入译文，原文译文对照阅读；支持划词翻译、悬停翻译、输入框翻译、生词本和 YouTube 双语字幕。界面参考 Trancy：深灰底色、右侧图标栏的侧边面板。

## 文档

| 文档 | 内容 |
| --- | --- |
| [更新日志](CHANGELOG.md) | 每个版本的功能更新、修复与修改记录 |
| [架构设计说明](docs/architecture.md) | 分层架构、核心模块设计、数据流、关键决策与取舍、性能、安全、演进方向 |
| [配置指南](docs/configuration.md) | 各引擎 API Key 获取方式、全部设置项说明、导入导出、快捷键 |
| [测试指南](docs/testing.md) | 自动化测试命令、手动测试清单、问题排查 |
| [开发指南](docs/development.md) | 架构、消息协议、整页翻译实现、新增引擎步骤、调试与发布 |
| [常见问题](docs/faq.md) | 安装使用、引擎报错、YouTube 字幕、隐私 |
| [示例配置](docs/settings.example.json) | 可在设置页“导入设置”直接导入 |

## 功能

| 功能 | 说明 |
| --- | --- |
| 网页双语对照 | 点击悬浮球或 `Alt+A`，按段落插入译文；只翻译进入视口的内容，滚动时懒加载，动态内容自动补译 |
| 仅显示译文 | 双语 / 仅译文一键切换（`Alt+S`），不改动原网页 DOM 结构 |
| 译文样式 | 默认、下划线、虚线、高亮、引用条、弱化、彩色、学习模式（模糊，悬停显示） |
| 侧边面板 | 点击工具栏图标，或悬浮球菜单中的“面板”打开；右侧图标栏切换首页、设置、生词本，常用设置一步直达 |
| 划词翻译 | 选中文字出现图标，点击弹出翻译面板；可切换引擎、朗读、复制、收藏；中英自动互译 |
| 生词本 | 在划词面板点 ☆ 收藏单词或句子，在侧边面板中查看、朗读、删除 |
| 悬停翻译 | 按住 `Alt` 指向任意段落，只翻译这一段，再按一次还原 |
| 输入框翻译 | 在输入框末尾连按三次空格，把内容翻译成指定语言（默认英文，需在设置中开启） |
| YouTube 双语字幕 | 打开 CC 后自动显示原文 + 译文；自动生成字幕会合并成整句；鼠标移上字幕暂停，点击单词查词 |
| 网站规则 | 总是翻译 / 永不翻译的域名列表 |
| 翻译缓存 | IndexedDB 缓存 30 天，相同文本不重复请求 |

## 翻译引擎

| 引擎 | 类型 | 配置 |
| --- | --- | --- |
| Google 翻译 | 机器翻译 | 免费，开箱即用（默认） |
| Microsoft 翻译 | 机器翻译 | Azure Translator Key + 区域（免费层每月 200 万字符） |
| DeepL | 机器翻译 | API Key，`:fx` 结尾自动走 Free 接口 |
| OpenAI GPT | 大模型 | API Key，可改 API 地址与模型 |
| Google Gemini | 大模型 | API Key |
| DeepSeek | 大模型 | API Key |
| Anthropic Claude | 大模型 | API Key |
| 自定义 | 大模型 | 任意 OpenAI 兼容接口：Ollama、LM Studio、OpenRouter、通义千问、Kimi 等 |

大模型翻译会把多个段落打包成一次请求（JSON 数组进、JSON 数组出），解析失败时自动降级为逐段翻译。提示词和 temperature 可在“AI 翻译设置”中修改。

## 安装

1. 打开 `chrome://extensions`，开启右上角“开发者模式”
2. 点击“加载已解压的扩展程序”，选择本项目根目录
3. 首次安装会自动打开设置页，Google 翻译无需配置即可使用

无需构建步骤，纯原生 JavaScript（ES Modules）。修改代码后在扩展页点“重新加载”即可。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Alt+A` | 翻译 / 还原当前页面 |
| `Alt+S` | 切换双语 / 仅译文 |
| `Alt+Q` | 打开插件面板 |
| 按住 `Alt` 悬停 | 翻译鼠标下的段落 |

可在 `chrome://extensions/shortcuts` 中自定义。

## 目录结构

```
manifest.json
src/
  shared/          settings.js（默认设置/读写）  languages.js（语言与各引擎代码映射）
  background/      index.js（消息路由、缓存、右键菜单、快捷键）  cache.js（IndexedDB）
    engines/       mt.js（Google/Microsoft/DeepL）  llm.js（GPT/Gemini/DeepSeek/Claude/自定义）
  content/         content.js（页面翻译、悬浮球、划词、悬停、输入框）
                   content.css（页面内译文样式）  ui.css（Shadow DOM 内的 UI）
                   yt-hook.js（MAIN world 拦截字幕请求）  youtube.js（双语字幕渲染）
panel/             侧边面板（工具栏弹窗与网页内抽屉共用同一页面）
options/           设置页
styles/theme.css   共享主题
icons/
docs/              配置、测试、开发文档与示例配置
tests/             e2e.py（Playwright 端到端测试）  fixtures/（测试页）
```

## 测试

```bash
pip3 install playwright && python3 -m playwright install chromium
python3 tests/e2e.py
```

手动测试清单见 [测试指南](docs/testing.md)。

## 工作原理

```
网页 DOM ──扫描──▶ 翻译单元（块级元素内连续的 inline 文本）
   │                    │ IntersectionObserver：进入视口才翻译
   │                    ▼
   │             批量队列（80ms 合并，≤40 段 / 5000 字符）
   │                    │ chrome.runtime.sendMessage
   │                    ▼
   │          Service Worker：去重 → IndexedDB 缓存 → 引擎
   │                    │
   └──── <gl-trans> 插入译文 ◀──┘
```

- 跳过 `code`、`pre`、输入框、`translate="no"`、`.notranslate` 和已经是目标语言的文本
- “仅译文”模式通过 `font-size:0` 隐藏原文文本节点，不移动、不删除网页原有节点，对 React/Vue 页面更安全
- 悬浮球、划词面板放在 Shadow DOM 中，与网页样式互不干扰
- 侧边面板是扩展自己的页面（`panel/panel.html`），在工具栏中作为弹窗打开，在网页中以 iframe 抽屉打开，两处共用一套代码

## 已知限制

- Microsoft 的 Edge 免费鉴权接口已下线，因此 Microsoft 需要 Azure Key
- 段落内的链接、加粗等格式不会保留到译文中（译文为纯文本）
- YouTube 字幕依赖播放器自身的字幕请求，需要先打开 CC；全屏时划词面板不可见
