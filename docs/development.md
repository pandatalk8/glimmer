# 开发指南

想改代码、加引擎或排查问题，先读这一篇。想了解每个设计决策背后的理由，见 [架构设计说明](architecture.md)。项目没有构建步骤，全部是原生 JavaScript，改完在 `chrome://extensions` 点“重新加载”就能生效。

---

## 一、本地运行

**第一步，** 打开 `chrome://extensions`，开启“开发者模式”。

**第二步，** “加载已解压的扩展程序”，选择项目根目录（包含 `manifest.json` 的目录）。

**第三步，** 修改代码后：

| 改动的文件 | 需要做什么 |
| --- | --- |
| `src/background/**`、`src/shared/**` | 扩展页点“重新加载” |
| `src/content/**` | 重新加载扩展 **并刷新网页** |
| `panel/**`、`options/**` | 关闭后重新打开面板或设置页（网页内抽屉需重新加载扩展并刷新网页） |
| `manifest.json` | 重新加载扩展 |

> 重新加载扩展后，已打开网页里的旧内容脚本会失效，划词时会提示“扩展已更新，请刷新页面”，这是正常现象。

最低 Chrome 版本为 111（YouTube 字幕用到了 `world: "MAIN"` 内容脚本）。

---

## 二、架构

```
┌──────────── 网页（每个 frame） ────────────┐
│ content.js   扫描 DOM → 翻译单元 → 插入译文   │
│ youtube.js   字幕解析与渲染（仅 YouTube）      │
│ yt-hook.js   MAIN world，拦截 timedtext 请求   │
└───────────────┬─────────────────────────────┘
                │ chrome.runtime.sendMessage
┌───────────────▼─────────────────────────────┐
│ background/index.js（Service Worker）         │
│   消息路由 → 去重 → cache.js(IndexedDB)        │
│            → engines/mt.js | engines/llm.js   │
└───────────────┬─────────────────────────────┘
                │ fetch（host_permissions 免 CORS）
         Google / Azure / DeepL / 各家大模型 API
```

所有网络请求都在 Service Worker 中发出，内容脚本只负责 DOM。这样做有两个好处：API Key 不会暴露给网页，扩展的 `host_permissions` 也让请求不受网页 CORS 限制。

### 消息协议

内容脚本、面板、设置页都通过 `chrome.runtime.sendMessage({ type, ...data })` 调用后台，返回 `{ ok: true, data }` 或 `{ ok: false, error }`。

| type | 参数 | 返回 |
| --- | --- | --- |
| `translate` | `texts: string[]`，可选 `to`、`from`、`engine`、`noCache` | `string[]`，与输入一一对应 |
| `getSettings` | — | 合并默认值后的完整设置 |
| `saveSettings` | `patch`（部分设置，深合并） | 新设置 |
| `meta` | — | `{ engines, languages }` |
| `testEngine` | `engine` | `{ text, ms }` |
| `clearCache` | — | `true` |
| `openOptions` | — | — |
| `tabInfo` | — | 发送方所在标签页 `{ id, url }`；面板以抽屉形式运行时用它找到自己所在的网页 |
| `toggleWord` | `word`、`trans`、`url` | `{ saved, count }`，已收藏则取消，未收藏则加入生词本 |
| `hasWord` | `word` | `boolean` |

后台发给内容脚本（`chrome.tabs.sendMessage`）：

| type | 作用 |
| --- | --- |
| `togglePage` | 切换整页翻译 |
| `setPage` | `on: boolean`，开启或关闭整页翻译 |
| `translateSelection` | `text`，弹出划词面板（右键菜单使用） |
| `getState` | 返回 `{ active, units, host }`，仅顶层 frame 响应 |
| `toggleDrawer` | `view`（可选），打开或收起网页内侧边面板 |

内容脚本发给面板：整页翻译开关变化时广播 `{ type: 'pageStateChanged', active }`，面板据此同步“翻译此页面”开关。

面板（抽屉）发给内容脚本：`parent.postMessage({ source: 'glimmer-panel', type: 'close' })` 请求收起抽屉，内容脚本会校验 `event.origin` 必须是本扩展。

### 设置的流转

设置统一存在 `chrome.storage.local` 的 `settings` 键中，默认值定义在 `src/shared/settings.js` 的 `DEFAULT_SETTINGS`。读取时永远与默认值深合并，所以新增设置项只要在默认值里加上，旧用户升级后也能读到。

内容脚本监听 `chrome.storage.onChanged`，一旦设置变化就向后台重新拉取合并后的设置并即时生效。引擎或目标语言改变时，正在翻译的页面会自动重译。

---

## 三、整页翻译的实现

### 翻译单元

`content.js` 的核心是把页面切成“翻译单元”：

1. 用 `TreeWalker` 遍历文本节点，跳过 `SKIP_TAGS`（code、pre、输入框、svg 等）、`translate="no"`、`.notranslate` 和可编辑区域
2. 每个文本节点向上找到最近的块级祖先（`display` 不是 inline 的元素）
3. 把块级元素的子节点按“连续 inline 段”切分，每段是一个单元。这样 `<div>文字<p>段落</p></div>` 会得到两个单元，不会重复翻译
4. 多个并列 inline 元素且中间没有文字（如导航栏链接）时，每个元素单独成为一个单元
5. 文本已经是目标语言、纯数字或纯网址的跳过

### 懒加载与批量

- 单元先交给 `IntersectionObserver`（上下预加载 600px），进入视口才插入占位并排队
- 队列 80ms 合并一次，每批最多 40 段 / 5000 字符发给后台
- 后台按引擎再拆分：Google 每段一个请求（并发 6），Azure 与 DeepL 每 50 段一个请求，大模型每 16 段 / 2400 字符一个请求（并发 3）
- `MutationObserver` 监听新增节点，400ms 防抖后只扫描新增部分

### 插入方式

译文统一放在自定义元素 `<gl-trans>` 中：

- “纯单元”（块里只有这一段文字）：追加到块元素末尾，并给块元素加 `.gl-host`
- 其他情况：插入到该段最后一个节点之后

“仅显示译文”模式不删除任何原节点：`.gl-host` 设置 `font-size: 0` 隐藏原文文本，再用插入时记录的 `--gl-fs`、`--gl-mt` 等 CSS 变量恢复译文字号和段落间距。这样关闭翻译时只需移除 `<gl-trans>` 和 class，React、Vue 等框架管理的 DOM 不会被破坏。

### UI 隔离

悬浮球、划词图标、翻译面板和 Toast 都挂在 `<glimmer-ui>` 的 Shadow DOM 中，样式来自 `src/content/ui.css`（已在 `web_accessible_resources` 中声明），与网页样式完全隔离。

### 侧边面板

`panel/panel.html` 同时是工具栏弹窗和网页内抽屉：

| 形态 | 打开方式 | URL | 如何找到当前网页 |
| --- | --- | --- | --- |
| 弹窗 | 点击工具栏图标 | `panel.html` | `chrome.tabs.query({ active: true })` |
| 抽屉 | 悬浮球菜单“面板” | `panel.html?mode=drawer&view=home` | 向后台发送 `tabInfo`，取 `sender.tab` |

面板是单页应用：`VIEWS` 中定义首页、设置、生词本和选项页四类视图，右侧图标栏切换视图。设置页的每一行都由 `PICKERS` 中的一项驱动，每项提供 `get(settings)` 读取当前值、`options()` 列出选项、`set(value)` 返回要保存的设置片段。新增一个面板设置项只需在 `PICKERS` 加一项，再在 `VIEWS.settings` 中加一行。

抽屉以 iframe 加载，因此 `panel/*`、`styles/*`、`src/shared/*`、`icons/*` 都声明在 `web_accessible_resources` 中。

---

## 四、新增一个翻译引擎

以接入一个假想的 `foo` 引擎为例。

**第一步，在 `src/shared/settings.js` 注册。**

```js
// ENGINES 数组中加一项
{ id: 'foo', name: 'Foo 翻译', type: 'mt', needKey: true },

// DEFAULT_SETTINGS.engines 中加默认配置
foo: { apiKey: '' },
```

`type` 决定设置页的标签，`free: true` 显示“免费”，`needKey: true` 时面板的引擎列表会标注“需 API Key”。

**第二步，实现翻译函数。** 机器翻译放在 `src/background/engines/mt.js`：

```js
export async function foo(texts, { from, to, cfg }) {
  if (!cfg.apiKey) throw new Error('请先在设置中填写 Foo API Key');
  const res = await fetch('https://api.foo.com/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify({ q: texts, target: to }),
  });
  if (!res.ok) throw await httpError(res, 'Foo');
  return (await res.json()).translations; // 必须与 texts 等长且顺序一致
}
```

函数约定：输入 `string[]`，输出等长的 `string[]`；`from` 可能是 `'auto'`；语言代码与 Google 一致（`zh-CN`、`en`），需要转换时在 `src/shared/languages.js` 中加映射字段。报错用 `httpError` 包装，它会把 401、429 等状态码翻译成中文提示。

如果是 OpenAI 兼容的大模型，不需要写请求代码，只要在 `llm.js` 的 `CHAT` 表里加一项，复用 `openaiChat` 即可。

**第三步，在 `src/background/index.js` 路由。** 机器翻译引擎加到 `MT` 对象：

```js
const MT = { google, microsoft, deepl, foo };
```

大模型引擎不用改，未在 `MT` 中的引擎默认走 `llmTranslate`。

**第四步，在 `options/options.js` 的 `ENGINE_UI` 中描述设置卡片。**

```js
foo: {
  logo: 'F', color: '#ff6a00', desc: '一句话介绍。',
  fields: [{ k: 'apiKey', label: 'API Key', secret: true, ph: 'foo-...' }],
},
```

`fields` 中的 `k` 对应 `engines.foo` 下的字段名，`secret` 显示为密码框，`list` 提供下拉建议。

**第五步，** 如果 API 域名特殊，确认 `manifest.json` 的 `host_permissions` 覆盖它（当前为 `<all_urls>`，无需修改）。

---

## 五、调试

| 要调试的部分 | 打开方式 |
| --- | --- |
| 后台 / 引擎请求 | `chrome://extensions` → 本扩展 → “Service Worker” 链接，打开 DevTools 看 Network 和 Console |
| 内容脚本 | 网页 DevTools → Console 顶部上下文下拉框选择“微光翻译”，即可访问 `window.__glimmer` |
| 面板（弹窗） | 右键扩展图标 → “审查弹出内容” |
| 面板（抽屉） | 网页 DevTools → Console 上下文下拉框选择 `panel.html` |
| 设置页 | 设置页中直接按 F12 |
| 缓存 | Service Worker DevTools → Application → IndexedDB → `glimmer-cache` |

常用技巧：

- 测试引擎时绕过缓存：在设置页 Console 执行 `chrome.runtime.sendMessage({type:'translate', texts:['hello'], engine:'deepl', noCache:true})`
- 查看当前设置：`chrome.storage.local.get('settings').then(console.log)`
- 恢复出厂：`chrome.storage.local.clear()` 后重新加载扩展

---

## 六、测试

项目没有单元测试框架，开发时使用 Playwright 加载扩展做端到端验证。核心思路：

```python
ctx = await p.chromium.launch_persistent_context(
    profile_dir, channel='chromium', headless=True,
    args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'])
sw = ctx.service_workers[0] or await ctx.wait_for_event('serviceworker')
# 通过 Service Worker 给页面发消息开启翻译
await sw.evaluate("""async()=>{const [t]=await chrome.tabs.query({active:true});
  await chrome.tabs.sendMessage(t.id,{type:'setPage',on:true})}""")
```

建议每次改动后验证的场景：

| 场景 | 检查点 |
| --- | --- |
| 整页翻译 | `<gl-trans>` 数量正确；code、pre、中文段落被跳过；嵌套块不重复 |
| 仅译文模式 | 原文隐藏，段落间距和列表符号正常 |
| 关闭翻译 | `document.querySelectorAll('gl-trans').length === 0` |
| 划词 | 选中文本后出现 `.sel-icon`，点击后面板显示译文 |
| 大模型批量 | 用本地 mock 的 `/v1/chat/completions` 服务，确认多段只发一次请求 |
| YouTube | 用 `window.postMessage({source:'glimmer-yt', url, body})` 注入 json3 字幕，检查播放器内的 `.yt-sub` |

> 注意：Service Worker 中不允许动态 `import()`，测试时不能在 `sw.evaluate` 里导入引擎模块，应通过扩展页面发送 `translate` 消息来调用。

---

## 七、打包发布

```bash
# 在项目根目录打包（排除文档和开发文件）
zip -r glimmer-v0.2.0.zip manifest.json src panel options styles icons -x '*.DS_Store'
```

上传到 [Chrome 应用商店开发者后台](https://chrome.google.com/webstore/devconsole)。发布前：

1. 修改 `manifest.json` 的 `version`，并在 [`CHANGELOG.md`](../CHANGELOG.md) 中把“未发布”改为该版本号和日期（日常每次修改都要先记录到“未发布”，规则见更新日志开头）
2. 准备 `icons/icon512.png` 作为商店图标素材，以及 1280×800 的截图
3. 隐私说明中需声明：扩展会把网页文本发送给用户选择的翻译服务；API Key 仅存储在本地
4. `<all_urls>` 权限审核较严，需在说明中解释“需要在任意网页上翻译内容”
