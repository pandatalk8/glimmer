# 架构设计说明

一款沉浸式翻译扩展，难点不在“调用翻译接口”——那只是一个 `fetch`。真正难的是三件事：**在任意网站上找对要翻译的文字，插入译文却不破坏网页，以及在额度和速度之间取得平衡。**

在这之上，产品还有两块独立的能力：一个在网页内滑出的侧面板（设置、生词本、账户都在里面），以及基于 Supabase 和 Stripe 的账户与订阅。前者要解决“扩展 UI 如何与任意网页共存”，后者要解决“付费状态如何可信”。

本文记录微光翻译的整体架构、每个关键决策的理由和被放弃的方案。读完你应该能回答：某个功能为什么放在这一层，改动它会影响谁。

> 本文讲“为什么这样设计”。具体怎么改代码、怎么调试，见 [开发指南](development.md)。

---

## 一、设计目标与约束

### 目标

| 目标 | 衡量标准 |
| --- | --- |
| 沉浸式阅读 | 译文紧贴原文段落，保留原网页排版，随时一键还原 |
| 多引擎 | 机器翻译和大模型可自由切换，新增引擎改动不超过 4 个文件 |
| 省额度 | 只翻译看得见的内容，相同文本不重复请求 |
| 不破坏网页 | 在 React、Vue 等框架驱动的页面上开关翻译，页面功能不受影响 |
| 零构建 | 原生 JavaScript，克隆后直接“加载已解压的扩展程序”即可运行 |
| 账户可选 | 不登录也能使用全部翻译功能；账户只用于订阅 |
| 付费状态可信 | 会员状态只由服务端根据 Stripe 通知写入，客户端无法篡改 |

### 约束

- **Manifest V3。** 后台是 Service Worker，空闲约 30 秒后会被浏览器终止，不能依赖常驻内存
- **内容脚本运行在隔离世界（isolated world）。** 能操作 DOM，但看不到网页自己的 JavaScript 变量，也拦截不到网页发出的请求
- **网页环境不可控。** 任意 CSS、任意 DOM 结构、内容动态加载、严格的 CSP
- **用户自带 Key。** 翻译请求从用户浏览器直接发往翻译服务商，不经过我们的后端；后端（Supabase）只负责账户与订阅
- **只用托管服务。** 不自建、不运维服务器：账户和数据库用 Supabase，服务端逻辑写成 Supabase Edge Functions，收款交给 Stripe

这些约束直接决定了下面的分层。

---

## 二、整体架构

```
┌──────────────────────────────── 浏览器标签页 ────────────────────────────────┐
│ 网页主世界 (MAIN)            内容脚本隔离世界 (isolated)                        │
│ ┌────────────────┐ postMessage ┌──────────────────────────────────────────┐ │
│ │ yt-hook.js     │ ──────────▶ │ youtube.js  字幕解析 / 渲染                  │ │
│ │ 拦截字幕请求    │  字幕数据    │ content.js  扫描 → 调度 → 渲染；悬浮球、划词、  │ │
│ └────────────────┘             │             悬停、输入框、本页生词、开关抽屉    │ │
│                                └───────┬──────────────────────────┬───────┘ │
│ 网页 DOM ◀── <gl-trans> 译文 ───────────┘                          │         │
│ <glimmer-ui> Shadow DOM：悬浮球、划词面板、Toast                     │         │
│    └ .drawer ─ <iframe panel.html?mode=drawer>  侧边面板（扩展源页面）│         │
└───────────────────────────────┬─────────────────────────────────────┼───────┘
                                │ runtime.sendMessage                  │
┌──────────────────────────── 扩展进程 ─────────────────────────────────▼───────┐
│  工具栏图标 ─▶ onActionClick（必要时注入内容脚本；内置页面退回弹窗）            │
│  ┌────────────────┐ ┌────────────┐   ┌──────────────────────────────────────┐ │
│  │ panel/ 面板     │ │ options/   │──▶│ background/index.js（Service Worker）  │ │
│  │ 首页·设置·生词·账户│ │ 完整设置页 │   │  消息路由 → 去重 → 缓存 → 引擎适配器    │ │
│  └───────┬────────┘ └─────┬──────┘   │  account.js：会话、会员状态、支付跳转   │ │
│          └── chrome.storage.local ◀──┴────────┬──────────────┬─────────────┘ │
│              设置 · 生词 · 会话 · 会员缓存      │ IndexedDB 缓存│              │
└────────────────────────────────────────────────┼──────────────┼──────────────┘
                                 翻译请求（fetch）│              │ 账户、支付请求（fetch）
                  ┌──────────────────────────────┘              ▼
                  ▼                                Supabase：Auth · 数据库（RLS）· Edge Functions
   翻译服务商：Google · Azure · DeepL · OpenAI              ▲                   │ 创建支付页 / 门户
   Gemini · DeepSeek · Claude · 自定义                       └── webhook ── Stripe ◀┘
```

整个系统分六层，每层只做一件事：

| 层 | 文件 | 职责 | 不做什么 |
| --- | --- | --- | --- |
| 页面层 | `src/content/*` | 理解 DOM、调度、渲染、网页内交互、承载抽屉 | 不发网络请求，不碰 API Key 和登录令牌 |
| 服务层 | `src/background/index.js`、`cache.js` | 消息路由、去重、缓存、工具栏点击 | 不关心 DOM，不关心具体引擎协议 |
| 适配层 | `src/background/engines/*` | 把 `string[]` 翻译成 `string[]` | 不关心缓存和调用方 |
| 账户层 | `src/background/account.js` | 会话保存与续期、读取会员状态、打开支付页 | 不决定会员状态，只读取 |
| 界面与配置层 | `src/shared/*`、`panel/`、`options/` | 设置的定义与读写、面板与设置页界面 | 不参与翻译流程 |
| 后端 | `supabase/` | 账户、会员数据、Stripe 支付与通知 | 不经手翻译内容 |

---

## 三、核心模块设计

### 3.1 DOM 扫描器：什么是“一段”

网页翻译的第一个问题是切分。按元素切太粗——一个 `<div>` 可能包着整篇文章；按文本节点切太细——`Hello <b>world</b>` 会被拆成两段，译文支离破碎。

扫描器的答案是 **“块级元素内连续的 inline 内容”** 为一个翻译单元：

```
<div>                                   单元 1：This div has direct text.
  This div has <b>direct</b> text.      ─────────────────────────────
  <p>A nested paragraph.</p>            单元 2：A nested paragraph.
</div>
```

算法分三步：

**第一步，收集文本。** `TreeWalker` 遍历文本节点，遇到 `SKIP_TAGS`（code、pre、输入框、svg 等）、`translate="no"`、可编辑区域时整棵子树跳过（`FILTER_REJECT`），不逐个检查后代。

**第二步，向上找块。** 每个文本节点沿父链上溯，直到遇到 `display` 不是 inline 的元素。`display` 的计算结果缓存在 `WeakMap` 中，同一元素只调用一次 `getComputedStyle`。

**第三步，按 inline 段切分。** 遍历块元素的直接子节点，块级子元素作为分隔符，其余节点累积成一段。两个特例：并列的 inline 元素之间没有文字（典型如导航栏链接）时逐个成段；行内 `code` 保留在段落内一起翻译。

已处理的文本节点记录在 `WeakSet` 中。这样动态内容重新扫描时只会处理新节点，节点被网页删除后也会被垃圾回收，不会内存泄漏。

**语言过滤** 在切分后进行：统计汉字、假名、谚文、拉丁字母的比例判断文本是否已经是目标语言。没有使用语言检测库——它们动辄几百 KB，而这里只需要回答“要不要翻”这一个二元问题。

### 3.2 调度器：什么时候翻

```
扫描得到单元 ──▶ IntersectionObserver（上下预加载 600px）
                       │ 进入视口
                       ▼
                 插入占位（转圈）──▶ 待发队列
                                      │ 80ms 内的单元合并
                                      ▼
                         切批：≤ 40 段 且 ≤ 5000 字符
                                      │
                                      ▼
                              sendMessage('translate')
```

**为什么懒加载？** 一篇维基百科长文有几百段，用户通常只读前几屏。按视口翻译让首屏更快出结果，也让大模型的花费下降一个数量级。

**为什么 80ms 合并？** 滚动时视口回调会密集触发，每次只带一两个段落。短暂合并后一次发送，请求数显著减少，而 80ms 的延迟人眼几乎察觉不到。

**动态内容** 由 `MutationObserver` 监听，400ms 防抖后只扫描新增节点所在的子树，而不是整页重扫。扩展自己插入的 `<gl-trans>` 和 `<glimmer-ui>` 会被过滤，避免“插入译文 → 触发扫描 → 再插入”的循环。

**过期结果丢弃。** 每次开启或关闭翻译时 `state.gen` 自增，请求返回时比对代数，不一致就丢弃。用户在翻译中途关闭或切换引擎时，迟到的结果不会写回页面。

### 3.3 渲染器：怎么插而不破坏

译文统一放进自定义元素 `<gl-trans>`。用自定义标签而非 `<span>`，是因为网站 CSS 里大量存在 `span { ... }`、`p > span` 这样的选择器，自定义标签天然不会被命中。

插入位置有两种：

| 情况 | 插入位置 | 块元素标记 |
| --- | --- | --- |
| 纯单元（块里只有这一段） | 追加到块元素末尾 | `.gl-host` + 记录字号、边距到 CSS 变量 |
| 混合单元 | 该段最后一个节点之后 | 无 |

**“仅显示译文”模式是整个渲染设计的关键决策。**

| 方案 | 做法 | 问题 |
| --- | --- | --- |
| 替换文本 | 把原文本节点内容改成译文 | React 等框架下次渲染时会覆盖或报错；还原需要备份 |
| 包裹原文 | 把原节点移入 `<span hidden>` | 移动节点会破坏框架的虚拟 DOM 对应关系 |
| **字号归零（采用）** | `.gl-host { font-size: 0 }`，译文用 `--gl-fs` 恢复字号 | 只能用于纯单元；需要额外记录边距 |

采用的方案**不移动、不修改、不删除任何网页原有节点**，只加 class 和 CSS 变量。关闭翻译时删掉 `<gl-trans>`、移除 class，页面就回到原状。代价是 `em` 单位的边距会随字号归零，所以插入时把计算后的 `margin`、`padding` 以像素值存进 CSS 变量，在仅译文模式下用 `!important` 还原。

**译文样式** 全部由 `<html>` 上的 `data-gl-style`、`data-gl-mode` 属性和 `--gl-color` 变量驱动。切换样式只改三个属性，不需要遍历任何译文元素。

### 3.4 UI 隔离：Shadow DOM

悬浮球、划词面板、Toast 挂在 `<glimmer-ui>` 的 Shadow DOM 中，样式通过 `<link>` 加载扩展内的 `ui.css`。侧边面板也挂在这里，但它的内容是一个 iframe，原因见 3.8。

- **网页样式进不来**：网站的 `* { box-sizing }`、`button { }` 不会污染扩展 UI
- **扩展样式出不去**：扩展的 class 名不会和网站冲突
- **事件判定简单**：`event.composedPath().includes(uiRoot)` 即可判断点击是否发生在扩展 UI 内

YouTube 字幕层单独挂在播放器元素 `#movie_player` 内部，而不是页面根节点。原因是全屏时浏览器只渲染全屏元素的子树，挂在根节点上的字幕会消失。

### 3.5 服务层：去重与缓存

后台的 `translate` 处理流程：

```
texts[] ──▶ 计算缓存键 ──▶ IndexedDB 批量读取
                              │
                 命中 ◀───────┴───────▶ 未命中 ──▶ Set 去重 ──▶ 引擎适配器
                  │                                              │
                  └──────────── 按原顺序合并 ◀── 写回缓存 ◀──────┘
```

**缓存键** 为 `引擎 + 模型 + 源语言 + 目标语言 + 原文`。加入模型是因为同一引擎换模型后译文质量不同，不应混用；没有加入提示词，是权衡后的取舍——提示词改动频率低，加入后每次微调都会让缓存全部失效。

**为什么用 IndexedDB 而不是内存？** Service Worker 随时会被终止，内存缓存活不过一分钟。`chrome.storage.local` 也可以存，但它是整体读写的键值存储，不适合上万条小记录。IndexedDB 支持按键随机读写，条目带时间戳，30 天过期。

缓存写入不等待完成（fire-and-forget），读取失败时降级为全部未命中。缓存是优化而非依赖，坏了也不影响翻译。

### 3.6 适配层：统一引擎接口

所有引擎实现同一个签名：

```js
async function engine(texts: string[], { from, to, cfg, settings }): Promise<string[]>
```

输入输出等长、同序，这是整个系统唯一的引擎契约。服务层不知道 DeepL 一次能收 50 段、Google 一次能收 64 段，这些差异封装在适配器内部：

| 引擎 | 批量策略 | 并发 | 语言代码 |
| --- | --- | --- | --- |
| Google | 每 64 段 / 4500 字符一个请求（`translate_a/t` 多 `q` 参数）；批量失败降级为逐段请求，限流（429）时不降级 | 3 | 原生 |
| Microsoft | 每 50 段一个请求 | 3 | `zh-Hans` 等，查表转换 |
| DeepL | 每 50 段一个请求 | 2 | `ZH-HANS` 等，源语言只取主代码 |
| 大模型 | 每 16 段 / 2400 字符打包成 JSON | 3 | 转为英文语言名写入提示词 |

**超时。** 所有引擎请求经过 `fetchT`：机器翻译 20 秒、大模型 90 秒无响应即报错，网络不通时给出“无法连接到翻译服务”。没有超时的话，服务商卡住时段落会一直显示加载圈，用户既看不到错误也无法重试。

语言代码转换集中在 `src/shared/languages.js`，内部统一使用 Google 风格代码（`zh-CN`、`en`），各引擎需要的代码作为同一行的附加字段。新增语言只改一处。

#### 大模型批量协议

大模型没有“批量翻译”接口，需要自己设计协议：

```
system: 专业译者提示词（{{to}} 替换为目标语言）
user:   Translate each string in the JSON array below into Simplified Chinese.
        Return ONLY a JSON object {"translations": [...]} containing exactly N strings...

        ["段落1", "段落2", ...]
```

模型输出不可信，所以解析是防御式的：去掉 Markdown 代码围栏，依次尝试整体解析、截取 `{...}`、截取 `[...]`，并校验数组长度等于 N。任何一步失败都**降级为逐段翻译**，用多花一点请求换取结果正确。HTTP 400 以外的错误（如 401、429）和超时直接抛出，不做无意义的重试。

为什么要求返回对象 `{"translations": [...]}` 而不是裸数组？部分 OpenAI 兼容服务的 JSON 模式要求顶层必须是对象，用对象格式兼容面更广。

四家大模型的差异只在“发一次对话”这一步，抽象为 `chat(cfg, system, user, temperature) → string`：

| 引擎 | 协议 | 差异点 |
| --- | --- | --- |
| OpenAI / DeepSeek / 自定义 | `/chat/completions` | 共用 `openaiChat`，仅默认地址不同；不支持 temperature 时自动去掉重试 |
| Gemini | `generateContent` | `systemInstruction` 独立字段，过滤思考片段 |
| Claude | `/v1/messages` | `system` 独立字段，需 `anthropic-dangerous-direct-browser-access` 头 |

### 3.7 YouTube 字幕：跨世界协作

内容脚本运行在隔离世界，拦截不到网页自己发出的 `fetch`。而 YouTube 的字幕请求带有播放器动态生成的签名参数，扩展自己构造请求会失败。

解决方案是 **在主世界放一个只做拦截的最小脚本**：

```
yt-hook.js (MAIN, document_start)          youtube.js (isolated)
  包装 fetch / XMLHttpRequest.open
  URL 含 /api/timedtext ──clone 响应──▶ postMessage ──▶ 校验 source
                                                       │
                                     json3 / XML 解析 ◀┘
                                           │
                       自动字幕：按停顿 >1.5s、句末标点、>90 字符合并成句
                                           │
                       从当前播放位置开始，每 40 句一批翻译
                                           │
                       requestAnimationFrame 循环 + 二分查找当前字幕
```

主世界脚本刻意保持极简：不读设置、不调用扩展 API、只转发数据。主世界里的代码对网页完全可见，越少越安全。

渲染采用 `requestAnimationFrame` 而非 `timeupdate` 事件，因为后者每秒只触发约 4 次，字幕切换会有明显延迟。每帧用二分查找定位当前字幕，索引未变时直接返回，不触碰 DOM。

### 3.8 面板：一个页面，两种形态

侧边面板需要出现在两个地方：网页内从右侧滑出的抽屉（点击工具栏图标或悬浮球菜单），以及无法嵌入网页时（`chrome://` 等内置页面）的工具栏弹窗。两处内容完全一样——首页、设置、生词本、账户、右侧图标栏。

| 方案 | 做法 | 问题 |
| --- | --- | --- |
| 两套实现 | 弹窗写一套，内容脚本在 Shadow DOM 里再写一套 | 代码重复；内容脚本不能 `import` 共享模块，设置逻辑要再抄一遍 |
| **一个扩展页面（采用）** | `panel/panel.html` 既作弹窗，又以 iframe 嵌入网页 | 需要把面板资源声明为 `web_accessible_resources` |

```
工具栏图标 ──▶ background.onActionClick
                 ├ ping 内容脚本，不在则 chrome.scripting 注入
                 ├ 成功 ──▶ tabs.sendMessage(toggleDrawer) ─┐
                 └ 失败 ──▶ setPopup + openPopup ──▶ panel.html（弹窗）
悬浮球“面板” ───────────────────────────────────────────────┤
                                                            ▼
               <glimmer-ui> Shadow DOM
                 └ .drawer
                    └ <iframe src="panel.html?mode=drawer">
                         │ runtime.sendMessage(tabInfo) → sender.tab
                         │ tabs.sendMessage(tab, setPage / getState)
                         └ parent.postMessage(close) ──▶ 内容脚本校验 origin 后收起
```

为什么悬浮球、划词面板用 Shadow DOM，侧边面板却用 iframe？前两者很小、要紧贴选区定位、只需展示几行文字，Shadow DOM 足够轻；侧边面板是一个完整应用，要读写设置、生词、登录令牌，用扩展页面才能直接使用扩展 API 和共享模块，也能把令牌留在扩展源内，网页读不到。

iframe 中的面板是扩展源（`chrome-extension://`）页面，可以直接使用全部扩展 API 和共享模块，与网页 JavaScript 完全隔离；网页无法读取 iframe 内容。抽屉打开时，悬浮球随之左移到抽屉边缘，避免被遮挡。

**状态同步** 不靠互相调用，而是靠两条广播：设置与生词写入 `chrome.storage.local`，所有面板监听 `onChanged` 刷新；整页翻译开关由内容脚本广播 `pageStateChanged`。因此无论从悬浮球、快捷键、弹窗还是抽屉操作，各处显示始终一致。

### 3.9 后端：账户与订阅

翻译本身不需要后端，账户和付费订阅需要。后端只用两家托管服务，没有自建服务器：

| 职责 | 服务 | 位置 |
| --- | --- | --- |
| 注册、登录、令牌 | Supabase Auth | 托管 |
| 会员状态 | Supabase 数据库：`profiles`、`subscriptions`、`stripe_events` | `supabase/migrations/` |
| 创建支付页、客户门户、接收通知 | Supabase Edge Functions（Deno） | `supabase/functions/` |
| 收款与订阅周期 | Stripe Checkout、客户门户、webhook | 托管 |

```
面板账户页 ──runtime.sendMessage──▶ background/account.js
                                      ├ /auth/v1/*           注册、登录、刷新令牌、重置密码
                                      ├ /rest/v1/profiles    读取自己的会员状态（RLS）
                                      └ /functions/v1/billing-checkout | billing-portal
                                                 │ 返回 Stripe 页面地址 → 新标签页打开
Stripe ──webhook──▶ stripe-webhook ──验证签名──▶ handleEvent ──▶ subscriptions、profiles
支付返回页 billing-return ──tabs.onUpdated──▶ account.js 刷新会员状态 → storage → 面板
```

**一次订阅的完整过程：**

```
面板          account.js           Supabase                     Stripe
 │ 登录          │                    │                            │
 │─────────────▶│──/auth/v1/token────▶│                            │
 │              │◀──会话（令牌）──────│                            │
 │              │──/rest/v1/profiles─▶│ RLS：只返回自己             │
 │ 月付 / 年付    │                    │                            │
 │─────────────▶│──billing-checkout──▶│ 建 customer、Checkout ────▶│
 │              │◀──支付页地址────────│◀───────────────────────────│
 │              │ 新标签页打开 ─────────────────────────────────────▶│ 用户付款
 │              │                    │◀──webhook（签名）───────────│
 │              │                    │ 写 subscriptions、plan=pro  │
 │              │◀─tabs.onUpdated：billing-return 页面打开            │
 │              │──/rest/v1/profiles─▶│                            │
 │◀─storage──────│ account.plan = pro │                            │
```

支付返回页打开时，webhook 可能还没到达，所以 `account.js` 在返回页打开后的第 0、2、7、17 秒各刷新一次，拿到 Pro 即停止。

**三个关键决策：**

- **扩展不引入 Supabase SDK，直接调用 REST 接口。** 项目没有构建步骤，SDK 需要打包；而扩展只用到注册、登录、刷新、读一张表、调两个函数，用 `fetch` 写一百多行就够了。会话保存在 `chrome.storage.local`，令牌在过期前 60 秒自动刷新，多个请求同时刷新时共用同一次刷新
- **会员状态只由服务端写入。** `profiles` 表只给登录用户开放“读自己”的 RLS 策略，没有 update 策略；套餐字段只有 webhook 用 service role 写入。用户即使拿到自己的令牌，也无法把自己改成 Pro
- **订阅逻辑与外部依赖分离。** `_shared/billing.ts` 只依赖注入的 `BillingDeps` 接口，不直接引用 Stripe SDK 和数据库客户端，因此能在单元测试中用内存数据库验证全部状态转换

**订阅状态到套餐的映射：** `active`、`trialing` 为 Pro；`past_due`（续费扣款失败）保留 Pro 作为宽限期，界面提示更新支付方式；其余状态（`canceled`、`unpaid`、`incomplete` 等）为免费版。用户设置“到期取消”时，`cancel_at_period_end` 为真，到期前仍是 Pro。

**可靠性：** Stripe 可能重复或乱序投递事件。每个事件 ID 先写入 `stripe_events`，主键冲突即视为已处理；同步时总是以订阅对象的当前状态为准（`checkout.session.completed` 会重新获取订阅），而不是累加变化，因此乱序也能得到正确结果。处理失败返回 500，让 Stripe 稍后重试。

---

## 四、数据流

### 4.1 整页翻译时序

```
用户       悬浮球/快捷键     content.js        background         引擎
 │  点击/Alt+A  │               │                  │                │
 │─────────────▶│  togglePage   │                  │                │
 │              │──────────────▶│ scan(body)       │                │
 │              │               │ observe 单元      │                │
 │  滚动        │               │ 进入视口→占位     │                │
 │─────────────────────────────▶│ 80ms 合并         │                │
 │              │               │──translate──────▶│ 查缓存/去重     │
 │              │               │                  │──fetch────────▶│
 │              │               │                  │◀───────────────│
 │              │               │◀──string[]───────│ 写缓存          │
 │              │               │ 校验 gen，填充译文 │                │
```

### 4.2 设置变更传播

`chrome.storage.local` 是设置的**唯一事实来源**。任何界面都不互相通知，只写存储：

```
面板 / options / 悬浮球菜单 / 划词面板
        │ saveSettings(patch)：读取 → 深合并 → 写回
        ▼
chrome.storage.local ──onChanged──▶ 所有标签页的 content.js
                                       │ 向后台拉取合并默认值后的设置
                                       ├ 样式/模式变化 → 改 <html> 属性
                                       ├ 悬浮球开关 → 显示/移除
                                       └ 引擎/语言变化 → 重新翻译当前页
```

同样的机制也用于生词和账户：`words` 变化时，所有打开的面板重新计算“本页生词”；`auth`、`account` 变化时（登录、退出、支付后刷新），面板重新读取会员状态并更新账户行与 Pro 标识。

内容脚本收到变更后不直接使用 `newValue`，而是向后台重新请求。原因是存储里的值可能不完整（例如导入了只含部分字段的配置），合并默认值的逻辑只应存在一处。

### 4.3 数据模型

**设置**（`chrome.storage.local` 键 `settings`）：

```
settings
├── engine, sourceLang, targetLang       翻译基础
├── displayMode, transStyle, transColor  呈现
├── floatBall, selection{}, hover{}, inputTranslate{}, youtube{}   交互开关
├── alwaysSites[], neverSites[]          网站规则
├── llm{ prompt, temperature }           大模型共用参数
└── engines{ google{}, microsoft{}, deepl{}, openai{}, gemini{}, deepseek{}, claude{}, custom{} }
```

读取时与 `DEFAULT_SETTINGS` 深合并：对象递归合并，数组整体替换。新版本增加设置项时只需在默认值里添加，老用户无需迁移脚本。

**生词本**（`chrome.storage.local` 键 `words`）：数组，最新在前，每项 `{ w: 原文, t: 译文, url: 来源页, ts: 时间戳, m: 是否已掌握 }`，按小写去重，上限 5000 条。“本页生词”由面板把整个生词表发给内容脚本，内容脚本对 `document.body.innerText` 分词后取交集，不额外存储。

**账户**（`chrome.storage.local`）：`auth` 保存会话 `{ access_token, refresh_token, expires_at, user }`；`account` 保存界面显示用的会员状态 `{ email, plan, status, periodEnd, cancelAtPeriodEnd, hasBilling }`，只是缓存，以数据库为准。

**缓存**（IndexedDB `glimmer-cache` / 对象仓库 `tr`）：键为缓存键字符串，值为 `{ v: 译文, t: 写入时间 }`。

**后端数据库**（Supabase Postgres，`supabase/migrations/`）：

| 表 | 主要字段 | 谁能读 | 谁能写 |
| --- | --- | --- | --- |
| `profiles` | `id`（= 用户 ID）、`email`、`plan`（free / pro）、`stripe_customer_id`、`subscription_status`、`current_period_end`、`cancel_at_period_end` | 用户本人 | 注册触发器（创建）、Edge Functions |
| `subscriptions` | `id`（Stripe 订阅 ID）、`user_id`、`status`、`price_id`、`billing_interval`、`current_period_end`、`cancel_at_period_end` | 用户本人 | Edge Functions |
| `stripe_events` | `id`（Stripe 事件 ID）、`type`、`received_at` | 无 | Edge Functions（去重） |

`profiles` 是面板读取的唯一来源，`subscriptions` 保留订阅明细，便于以后支持多个订阅或查账。

---

## 五、关键设计决策

| 决策 | 选择 | 放弃的方案 | 理由 |
| --- | --- | --- | --- |
| 网络请求位置 | 全部在 Service Worker | 内容脚本直接请求 | Key 不进入网页进程；`host_permissions` 免除 CORS |
| 构建方式 | 原生 ES Modules，无构建 | TypeScript + Vite | 降低贡献门槛；代码量不足以抵消工具链成本 |
| 内容脚本 | 单文件 IIFE | 模块化拆分 | 内容脚本不支持静态 `import`；动态导入需暴露资源，增加攻击面 |
| 翻译时机 | 视口懒加载 | 整页一次翻完 | 首屏更快，大模型花费大幅下降 |
| 仅译文实现 | 字号归零 + CSS 变量 | 替换/包裹原文节点 | 不破坏框架管理的 DOM，还原零成本 |
| 译文容器 | 自定义元素 `<gl-trans>` | `<span>` / `<font>` | 不被网站 CSS 选择器命中 |
| 网页内小组件容器 | Shadow DOM（悬浮球、划词面板） | iframe | 更轻，可直接定位在选区旁 |
| 侧边面板容器 | iframe 加载扩展页面 | Shadow DOM | 完整应用，需要扩展 API、共享模块，令牌不能暴露给网页（见 3.8） |
| 语言判断 | 字符比例启发式 | 语言检测库 / 先调接口检测 | 零依赖、零请求，只需二元判断 |
| 缓存存储 | IndexedDB | 内存 / `storage.local` | SW 会被终止；大量小记录需要随机读写 |
| 设置同步 | `storage.local` | `storage.sync` | `sync` 单项限 8KB，且 API Key 不应同步到云端 |
| 大模型批量 | JSON 数组协议 + 降级 | 分隔符拼接 | 分隔符可能被模型改写或翻译；JSON 可校验数量 |
| 面板实现 | 同一扩展页面兼作弹窗与 iframe 抽屉 | 内容脚本中再实现一套 UI | 一套代码；可直接用扩展 API 和共享模块；与网页隔离 |
| 后端 | Supabase（Auth + 数据库 + Edge Functions）+ Stripe | 自建 Node 服务器 | 账户、数据库、函数一站托管，免运维；Stripe 负责合规收款 |
| 扩展连接后端 | 直接调用 REST 接口 | 打包 Supabase SDK | 不引入构建步骤；所需接口很少 |
| 会员状态写入 | 只由 Stripe webhook 经 Edge Function 写入 | 支付返回页由客户端上报 | 客户端可以伪造；webhook 有签名，是唯一可信来源 |
| 支付界面 | Stripe Checkout 与客户门户（跳转） | 在面板内嵌入支付表单 | 不接触银行卡信息，免去 PCI 合规；退款、发票、换卡由 Stripe 提供 |
| Microsoft 引擎 | Azure 官方 API | Edge 免费鉴权接口 | 后者已下线（返回 404），且属非官方用法 |

---

## 六、性能

| 手段 | 位置 | 效果 |
| --- | --- | --- |
| 子树整体跳过 | 扫描器 `FILTER_REJECT` | 代码块、SVG 等内部节点不逐个访问 |
| `display` 结果缓存 | 扫描器 `WeakMap` | 每个元素最多一次样式计算 |
| 视口懒加载 | 调度器 | 只处理可见内容 |
| 增量扫描 | `MutationObserver` | 只扫描新增子树 |
| 请求合并与批量 | 调度器 + 适配器 | 请求数减少一到两个数量级 |
| 去重 + 持久缓存 | 服务层 | 重复文本（导航、页脚、重访页面）零请求 |
| 字幕渲染短路 | YouTube 模块 | 字幕未切换时每帧只做一次二分查找 |
| Google 批量接口 | 适配层 | Hacker News 首页 65 段从 65 个请求、5–25 秒降为 2 个请求、约 1 秒 |
| 令牌刷新合并 | 账户层 | 多个请求同时发现令牌将过期时，只发一次刷新请求 |
| 会员状态本地缓存 | 账户层 | 面板打开即可显示，不等网络；后台再静默刷新 |

---

## 七、安全与隐私

- **Key 隔离。** API Key 只存在扩展存储中，只在 Service Worker 里读取。内容脚本和网页都拿不到；网页即使被 XSS，也无法通过扩展窃取 Key
- **不同步。** 使用 `storage.local` 而非 `storage.sync`，Key 不会上传到 Google 账户
- **翻译内容不经过我们的后端。** 网页文本只发往用户选择的翻译服务商；后端只保存账户邮箱和订阅状态
- **支付信息不经过我们。** 银行卡在 Stripe 的页面上填写，扩展和后端都接触不到；webhook 用 Stripe 签名验证，伪造的通知会被拒绝
- **密钥分级。** 扩展里只有可公开的 Supabase anon key；service_role key、Stripe 密钥只存在 Supabase 的函数环境变量中
- **数据库最小权限。** 所有表开启 RLS；用户只能读自己的 `profiles`、`subscriptions`，没有任何写权限；`stripe_events` 对用户完全不可见
- **登录令牌。** 访问令牌和刷新令牌保存在扩展的 `storage.local`，网页无法读取；内容脚本虽然有权访问扩展存储，但代码中只有后台 `account.js` 读写令牌，面板只通过消息获取会员状态，不使用令牌；退出登录时同时通知 Supabase 作废会话。刷新令牌失效时自动退出，不会反复用无效令牌请求
- **主世界最小化。** `yt-hook.js` 只转发字幕数据，不读取设置、不调用扩展 API；内容脚本接收消息时校验 `event.source === window` 和 `source` 标识
- **面板隔离。** 抽屉是扩展源的 iframe，网页读不到其中内容；面板发出的 `postMessage` 只有“关闭”一种，内容脚本校验来源必须是本扩展。代价是 `panel/*` 等资源对网页可见，网站可借此探测扩展是否安装
- **输出转义。** 划词面板、字幕中的文本全部经过 HTML 转义或使用 `textContent` 写入，译文中的恶意内容不会被当作 HTML 执行
- **用户可控。** “永不翻译”名单用于邮箱、内网等敏感站点；也可使用本地 Ollama，文本不出本机

---

## 八、扩展性

| 扩展场景 | 需要改动 |
| --- | --- |
| 新增机器翻译引擎 | `settings.js` 注册 → `mt.js` 实现 → `index.js` 的 `MT` 表 → `options.js` 卡片描述 |
| 新增 OpenAI 兼容大模型 | `settings.js` 注册 → `llm.js` 的 `CHAT` 表加一行 → `options.js` 卡片描述 |
| 新增语言 | `languages.js` 加一行 |
| 新增译文样式 | `content.css` 加一组 `[data-gl-style]` 规则 → `options.js` 的 `STYLES` 加一项 |
| 新增视频网站字幕 | 仿照 `yt-hook.js` + `youtube.js`，在 `manifest.json` 中注册对应站点 |
| 新增 Pro 功能 | 后台用 `account.isPro()` 判断；如果消耗服务端资源（如我们提供的 AI 额度），再在 Edge Function 中根据 `profiles.plan` 校验 |
| 新增后端接口 | `supabase/functions/` 新建函数（复用 `_shared/`）→ `config.toml` 设置是否校验 JWT → `account.js` 加调用 → `index.js` 注册消息 |
| 新增登录方式 | Supabase 后台开启对应 Provider → `account.js` 用 `chrome.identity.launchWebAuthFlow` 完成 OAuth 跳转 |
| 新增设置项 | `DEFAULT_SETTINGS` 加默认值 → 设置页加带 `data-path` 的控件，自动双向绑定；需要在面板中出现时，在 `panel.js` 的 `PICKERS` 加一项 |

---

## 九、已知局限与演进方向

| 局限 | 影响 | 演进方向 |
| --- | --- | --- |
| 译文为纯文本 | 段落内的链接、加粗不会保留到译文 | 用占位符标记 inline 元素（如 `<a0>…</a0>`），翻译后还原为对应节点 |
| 并发限制只在单次请求内生效 | 同一页面的多个批次可能同时请求，触发服务商限流 | 在 Service Worker 中为每个引擎设置全局令牌桶 |
| 混合单元无法“仅显示译文” | 块内既有文字又有子块时，仅译文模式仍显示原文 | 对这类单元用 `<font>` 包裹文本节点，仅在确认非框架管理时启用 |
| 缓存键不含提示词 | 修改提示词后需手动清除缓存 | 把提示词哈希加入大模型的缓存键 |
| 全屏时划词面板不可见 | YouTube 全屏下点词无反应 | 面板挂载点跟随 `document.fullscreenElement` |
| 无流式输出 | 大模型长段落需等待完整返回 | 单段翻译改用 SSE 流式，边生成边显示 |
| 仅支持 YouTube | 其他视频网站无双语字幕 | 抽象“字幕源”接口，按站点实现拦截与解析 |
| 依赖非官方 Google 接口 | 可能被限流或变更 | 增加 Google Cloud Translation 官方 API 作为可选项 |
| Pro 会员尚无专属功能 | 订阅流程已完整，但付费后没有额外权益 | 确定 Pro 权益（如生词本云同步、提供 AI 翻译额度），按“新增 Pro 功能”接入 |
| 只支持邮箱登录 | 用户需要记密码，注册要验证邮件 | 接入 Google 登录（`chrome.identity` + Supabase OAuth） |
| 会员状态是本地缓存 | 在 Stripe 后台直接操作订阅后，要等下次打开面板才更新 | 后台定时（如每 6 小时）刷新；需要服务端资源的 Pro 功能始终以服务端校验为准 |
| 生词本只在本机 | 换电脑或重装扩展会丢失 | 登录后同步到 Supabase（可作为 Pro 权益） |
| 后端尚未真实联调 | 账户与订阅只在模拟接口和单元测试中验证过 | 按 `docs/backend.md` 部署到 Supabase 并用 Stripe 测试模式跑通 |

---

## 写在最后

整个架构围绕一条原则展开：**对网页做加法，不做改法。** 扫描器只读，渲染器只插入自己的元素，仅译文模式只改样式，UI 关在 Shadow DOM 里。网页本身从未被修改，所以关掉翻译的那一刻，它就回到了原来的样子。

新增功能时，先问一句：这个改动是在网页上“加”东西，还是在“改”网页？如果是后者，值得再想想有没有别的办法。

账户与订阅则遵循另一条原则：**和钱有关的状态，只信服务端。** 客户端只读取、只缓存，从不决定谁是 Pro。
