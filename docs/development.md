# 开发指南

想改代码、加引擎或排查问题，先读这一篇。第一次在本机运行，先看 [本地运行指南](local-dev.md)。想了解每个设计决策背后的理由，见 [架构设计说明](architecture.md)。项目没有构建步骤，全部是原生 JavaScript，改完在 `chrome://extensions` 点“重新加载”就能生效。

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
│            → engines/mt.js（Google）          │
│            → account.js → 后端翻译代理（会员引擎）│
└───────┬─────────────────────────┬───────────┘
        │ fetch（免 CORS）          │ 带登录令牌
   Google 翻译            Supabase Edge Function translate
                           → DeepL / Azure / 各家大模型 API
```

所有网络请求都在 Service Worker 中发出，内容脚本只负责 DOM。登录令牌不会暴露给网页，扩展的 `host_permissions` 也让请求不受网页 CORS 限制。扩展里没有任何服务商 API Key：Google 免费直连，其余引擎的 Key 只在后端。

### 消息协议

内容脚本、面板、设置页都通过 `chrome.runtime.sendMessage({ type, ...data })` 调用后台，返回 `{ ok: true, data }` 或 `{ ok: false, error, code }`（`code` 为可选的错误类型，如 `upgrade`）。

| type | 参数 | 返回 |
| --- | --- | --- |
| `translate` | `texts: string[]`，可选 `to`、`from`、`engine`、`noCache` | `string[]`，与输入一一对应。不传 `engine` 时用默认引擎，默认引擎用不了（未登录、等级不够、额度用完）时自动改用 Google，并向发起的网页发送一次 `engineNotice`；传了 `engine` 时照常报错，错误带 `code`（`login` / `upgrade` / `quota`） |
| `getSettings` | — | 合并默认值后的完整设置 |
| `saveSettings` | `patch`（部分设置，深合并） | 新设置 |
| `meta` | — | `{ engines, languages }` |
| `testEngine` | `engine` | `{ text, ms }` |
| `clearCache` | — | `true` |
| `openOptions` | — | — |
| `tabInfo` | — | 发送方所在标签页 `{ id, url }`；面板以抽屉形式运行时用它找到自己所在的网页 |
| `toggleWord` | `word`、`trans`、`url` | `{ saved, count }`，已收藏则取消，未收藏则加入生词本；免费版满 100 个时报错（`code: 'upgrade'`） |
| `hasWord` | `word` | `boolean` |
| `accountState` | — | `{ configured, loggedIn, email, account }`，读本地缓存 |
| `accountRefresh` | — | 从数据库刷新会员状态后返回同上 |
| `accountSignUp` / `accountSignIn` | `email`、`password` | 注册返回 `{ needConfirm }`；登录返回 `{ account }` |
| `accountSignOut` | — | 退出并清除本地会话 |
| `accountReset` | `email` | 发送重置密码邮件 |
| `billingCheckout` | `plan: 'premium' \| 'premium_plus'`、`interval: 'month' \| 'year'` | 在新标签页打开 Stripe 支付页；已是会员时改为打开客户门户，返回 `{ opened: 'portal' }` |
| `billingPortal` | — | 在新标签页打开 Stripe 客户门户 |
| `openPremium` | — | 打开方案页，并以 `?from=标签ID` 记下用户正在阅读的网页（开通成功后“开始使用”回到这里） |

后台发给内容脚本（`chrome.tabs.sendMessage`）：

| type | 作用 |
| --- | --- |
| `togglePage` | 切换整页翻译 |
| `setPage` | `on: boolean`，开启或关闭整页翻译 |
| `translateSelection` | `text`，弹出划词面板（右键菜单使用） |
| `getState` | 返回 `{ active, units, host }`，仅顶层 frame 响应 |
| `toggleDrawer` | `view`（可选），打开或收起网页内侧边面板 |
| `ping` | 返回 `true`，后台用来判断内容脚本是否已注入 |
| `buildInfo`（发给后台） | 返回 `{ version, loaded, disk, stale }`：插件加载时与当前磁盘上的代码指纹和 `build.json`，`stale` 为真表示需要刷新插件 |
| `openExtensionsPage`（发给后台） | 打开 `chrome://extensions` 并定位到本插件 |
| `pageWords` | `words: string[]`，返回其中出现在当前网页上的词（单词整词匹配、短语子串匹配，不区分大小写） |

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

### 账户与后端

`src/background/account.js` 直接调用 Supabase REST 接口。连接哪个后端按优先级决定：`backendOverride`（扩展存储）> `config.js` 的 `BACKEND` > 开发版自动使用 `LOCAL_DEV_BACKEND`（本机 `127.0.0.1:54321`）。所以本地开发什么都不用改；测试或临时指向其他地址时，在后台写入覆盖地址：

```js
chrome.storage.local.set({ backendOverride: { supabaseUrl: 'http://127.0.0.1:54321', supabaseAnonKey: '...' } })
```

后端代码在 `supabase/`，部署步骤见 [后端部署指南](backend.md)。

**会员等级。** `src/shared/settings.js` 导出 `PLAN_RANK`（free 0 / premium 1 / premium_plus 2）、`PLAN_NAME`、`FREE_WORD_LIMIT`（100）和 `canUse(plan, engine)`，面板、设置页、方案页都用它们决定标注和是否打开方案页。这只是界面提示；真正的限制在后端（`translate` 函数的 `checkAccess`、`words` 表的 RLS）。新增会员功能时两边都要改。

**Premium 方案页。** `premium/premium.html` 是独立的扩展页面，从面板首页右上角的“Premium”标签或账户页“查看会员方案”打开。价格常量在 `premium.js` 的 `PRICE`，需与 Stripe 价格一致。未登录时点“开通”会弹出内嵌的登录页（`panel.html?view=account`），登录后自动继续所选方案。

### 侧边面板

`panel/panel.html` 同时是网页内抽屉和工具栏弹窗：

| 形态 | 打开方式 | URL | 如何找到当前网页 |
| --- | --- | --- | --- |
| 抽屉（默认） | 点击工具栏图标、`Alt+Q`、悬浮球菜单“面板” | `panel.html?mode=drawer&view=home` | 向后台发送 `tabInfo`，取 `sender.tab` |
| 弹窗（兜底） | 在无法注入脚本的页面点击工具栏图标 | `panel.html` | `chrome.tabs.query({ active: true })` |

工具栏点击的处理在 `background/index.js` 的 `onActionClick`：

1. 向标签页发送 `ping`；没有回应说明内容脚本不在（安装扩展前已打开的网页），用 `chrome.scripting` 注入 `content.js` 和 `content.css`
2. 注入成功则发送 `toggleDrawer` 开关抽屉
3. 注入失败（`chrome://` 等内置页面）则 `chrome.action.setPopup` 把该标签页切换为弹窗并 `openPopup()`；标签页跳转到新网页时（`tabs.onUpdated` 的 `loading`）恢复为抽屉模式

因为 `manifest.json` 不再设置 `default_popup`，点击图标才会触发 `chrome.action.onClicked`。

面板是单页应用：`VIEWS` 中定义首页、设置、生词本和选项页四类视图，右侧图标栏切换视图。设置页的每一行都由 `PICKERS` 中的一项驱动，每项提供 `get(settings)` 读取当前值、`options()` 列出选项、`set(value)` 返回要保存的设置片段。新增一个面板设置项只需在 `PICKERS` 加一项，再在 `VIEWS.settings` 中加一行。

抽屉以 iframe 加载，因此 `panel/*`、`styles/*`、`src/shared/*`、`icons/*` 都声明在 `web_accessible_resources` 中。

---

## 四、新增一个翻译引擎

会员引擎都在后端实现，以接入一个假想的 `foo` 机器翻译为例（需要 Premium）。

**第一步，在 `src/shared/settings.js` 注册。**

```js
// ENGINES 数组中加一项；tier 为 'free' | 'premium' | 'premium_plus'
{ id: 'foo', name: 'Foo 翻译', type: 'mt', tier: 'premium' },
```

面板引擎列表、设置页卡片、方案页的等级标注都读这里。

**第二步，在后端 `supabase/functions/_shared/translate.ts` 实现。**

```ts
// ENGINE_TIER 加一项，必须与扩展的 tier 一致
export const ENGINE_TIER = { ..., foo: 'premium' };

export async function fooTranslate(texts: string[], from: string, to: string): Promise<string[]> {
  const apiKey = key('FOO_API_KEY', 'Foo'); // 缺少时返回 503“服务端尚未配置”
  const data = await post('https://api.foo.com/translate', { Authorization: 'Bearer ' + apiKey }, { q: texts, target: to }, 'Foo');
  return data.translations; // 必须与 texts 等长且顺序一致
}
```

然后在 `supabase/functions/translate/index.ts` 的分支中调用它。大模型不用写请求代码：OpenAI 兼容接口在 `chatFor` 中加一项，复用 `openaiCompatible`，Token 数自动计入用量。

函数约定：输入 `string[]`，输出等长的 `string[]`；`from` 可能是 `'auto'`；语言代码与 Google 一致（`zh-CN`、`en`），需要转换时在 `src/shared/languages.js` 中加映射字段（后端复用同一张表）。

**第三步，设置服务端 Key 并补测试。** 本地写入 `supabase/functions/.env`，云端 `npx supabase secrets set FOO_API_KEY=...`；在 `supabase/functions/_shared/translate_test.ts` 中补充等级检查的用例。

**第四步，界面文案。** `options/options.js` 的 `ENGINE_UI` 加卡片描述（只有 `logo`、`color`、`desc`，没有输入框），方案页 `premium.js` 的功能列表与对比表加上该引擎。

扩展的 `background/index.js` 不用改：除 `google` 以外的引擎都经 `account.backendTranslate` 转给后端。

---

## 五、调试

| 要调试的部分 | 打开方式 |
| --- | --- |
| 后台 / 引擎请求 | `chrome://extensions` → 本扩展 → “Service Worker” 链接，打开 DevTools 看 Network 和 Console |
| 翻译代理 | 运行 `npx supabase functions serve` 的终端输出；云端在 Supabase 后台 Edge Functions → translate → Logs |
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
| 会员引擎 | 用本地模拟的 `/functions/v1/translate`，确认整页只发一次请求、带登录令牌、用量写回账户 |
| 账户与订阅 | `tests/e2e_account.py` 启动模拟的 Supabase 接口，覆盖注册、登录、错误提示、令牌续期、Premium 方案页、开通 Premium+、升级改走客户门户 |
| 后端订阅逻辑 | `deno test --allow-env --allow-net --allow-read supabase/functions/` |
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
3. 隐私说明中需声明：扩展会把网页文本发送给用户选择的翻译服务，会员引擎的文本经我们的服务器转发（不保存）；会收集邮箱用于登录
4. `<all_urls>` 权限审核较严，需在说明中解释“需要在任意网页上翻译内容”
