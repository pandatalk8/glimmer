# 后端部署指南：Supabase + Stripe

账户、会员订阅、付费翻译引擎和生词本云同步都需要后端。整套后端只用两家服务：**Supabase** 负责注册登录、数据库和翻译代理，**Stripe** 负责收款；DeepL、Microsoft 和各家大模型的 Key 只保存在后端。代码都在仓库的 `supabase/` 目录，照着下面的步骤做一遍，大约 30 分钟。

> 先用 Stripe 的**测试模式**跑通，确认无误后再切换到正式模式。测试模式不会产生真实扣款。
>
> 想先在本机完整跑一遍（本地 Supabase + Stripe 测试模式），见 [本地运行指南](local-dev.md)。

---

## 一、整体结构

```
扩展（面板 · 账户页）
   │  注册 / 登录 / 刷新令牌     ──▶ Supabase Auth
   │  读取自己的会员状态          ──▶ Supabase 数据库（profiles，RLS 只能读自己）
   │  升级 / 管理订阅            ──▶ Edge Function：billing-checkout / billing-portal
   │                                      │ 创建 Checkout / 客户门户
   ▼                                      ▼
新标签页打开 Stripe 支付页 ──支付──▶ Stripe ──webhook──▶ Edge Function：stripe-webhook
   │                                                        │ 验证签名，写入 subscriptions、profiles
   ▼                                                        ▼
返回页 billing-return ──扩展检测到后刷新会员状态◀── 数据库 plan = 'premium' / 'premium_plus'

扩展（DeepL / Microsoft / 大模型）──▶ Edge Function：translate
                                       │ 校验登录与会员等级、本月 AI 点数与字符额度
                                       ▼
                              DeepL · Azure · OpenAI · Gemini · DeepSeek · Claude
                                       │ 译文 + Token 数
                                       ▼
                              usage_monthly 累加（add_usage）
扩展（生词本）──会员登录后双向同步──▶ 数据库 words（RLS：仅会员读写自己的词）
```

| 目录 / 文件 | 作用 |
| --- | --- |
| `supabase/migrations/…_accounts_billing.sql` | 建表：`profiles`（会员状态）、`subscriptions`（订阅明细）、`stripe_events`（事件去重），以及行级权限和注册触发器 |
| `supabase/migrations/…_tiers_usage_words.sql` | 三档会员（`free` / `premium` / `premium_plus`）、`usage_monthly`（每月 Token、AI 点数与字符用量）、`add_usage` 原子累加、`words`（生词本云同步） |
| `supabase/functions/translate` | 翻译代理：校验会员等级与本月用量，调用 DeepL、Microsoft 或大模型，记录用量 |
| `supabase/functions/_shared/translate.ts` | 引擎等级表、访问检查、各服务商请求，有单元测试 |
| `supabase/functions/billing-checkout` | 按所选方案（Premium 年付、Premium+ 月付 / 年付）创建 Stripe 订阅支付页，需要登录；已是会员时提示改用客户门户 |
| `supabase/functions/billing-portal` | 打开 Stripe 客户门户（换方案、改卡、取消、发票），需要登录 |
| `supabase/functions/stripe-webhook` | 接收 Stripe 事件，验证签名后同步会员状态 |
| `supabase/functions/billing-return` | 支付完成 / 取消 / 邮箱验证后跳转的返回地址。返回纯文本：云端 Supabase 会把 supabase.co 上 GET 请求返回的网页改成 `text/plain` 并加 `sandbox`（防钓鱼），网页会显示成源代码。扩展检测到这个地址后接管标签页：支付回到发起页面，邮箱验证换成扩展内的 `welcome/verified.html` |
| `supabase/functions/check-email` | 注册前检查邮箱域名有没有邮件服务器（MX 记录），只接收域名。云端 Supabase 不会拒绝填错的域名（如 `a@panda.com`），照样“发出”验证邮件；扩展注册前先问这里，`deliverable: false` 时直接提示填错，最多等 4 秒。`.local`、`.test` 等测试域名放行。无需登录（`--no-verify-jwt`） |
| `supabase/functions/_shared/billing.ts` | 订阅同步的核心逻辑，有单元测试 |
| `src/shared/config.js` | 扩展里填写 Supabase 地址和 anon key |

**会员状态只由后端写入。** 用户在数据库里只有“读自己那一行”的权限，无法把自己改成会员；用量也只能由翻译代理写入。

---

## 二、准备 Supabase

**第一步，创建项目。** 登录 [supabase.com](https://supabase.com)，新建项目，记下数据库密码。

**第二步，记下项目信息。** Project Settings → API：

| 名称 | 用在哪 | 能否公开 |
| --- | --- | --- |
| Project URL（`https://xxxx.supabase.co`） | 扩展 `config.js` | 可以 |
| anon public key | 扩展 `config.js` | 可以（数据安全靠 RLS） |
| service_role key | 只在 Edge Functions 中自动注入 | **绝不能**放进扩展或提交到仓库 |
| Project Reference ID（`xxxx`） | `supabase link` 命令 | 可以 |

**第三步，配置邮箱登录。** Authentication → Sign In / Providers → Email：

- 保持开启 “Confirm email”（注册后需点击验证邮件），可以防止乱填邮箱
- Site URL：验证邮件和重置密码邮件中的链接最终跳到这里。`config.toml` 中设为云端返回页的“邮箱已验证”页面（`/functions/v1/billing-return?status=verified`），换项目时同步修改
- 默认的邮件发送有频率限制（每小时几封），正式上线前在 Authentication → Emails → SMTP Settings 配置自己的邮件服务

**第四步，建表。** 安装命令行工具后关联项目并推送迁移：

```bash
npx supabase login
npx supabase link --project-ref <你的 Project Reference ID>
npx supabase db push
```

`db push` 会执行 `supabase/migrations/` 中的 SQL。也可以把 SQL 文件内容粘贴到后台 SQL Editor 中执行，效果相同。

---

### 开启 Google 登录（可选）

登录页的“使用 Google 登录”和注册页的“使用 Google 注册”需要一个 Google OAuth 客户端：

**第一步，创建客户端。** 打开 [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials → Create Credentials → OAuth client ID，类型选 **Web application**。首次使用需要先配置 OAuth consent screen（应用名称填“微光翻译”，用户类型选 External）。

> 为什么不选“Chrome 扩展”类型？和 Google 交换凭据的是 Supabase 的服务器：Google 授权后跳回 Supabase 的 callback，Supabase 用 Client secret 换取用户身份，再把 Supabase 的登录令牌交给插件。“Chrome 扩展”类型没有 Client secret，也不能填跳转地址，只适用于插件直接调用 `chrome.identity.getAuthToken` 访问 Google 自己的接口。
>
> 同意屏幕处于 Testing 状态时，只有加入 Test users 的 Google 账号能登录；正式开放前在 Audience 页面点 Publish app。

**第二步，填写回调地址。** Authorized redirect URIs 填 Supabase 的回调地址：

| 环境 | 回调地址 |
| --- | --- |
| 云端 | `https://<项目 ID>.supabase.co/auth/v1/callback` |
| 本地 | `http://127.0.0.1:54321/auth/v1/callback` |

保存后记下 Client ID 和 Client secret。

**第三步，在 Supabase 中开启。** 推荐用命令：把 Client ID 和 Secret 写进 `supabase/.env`（`SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID`、`SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`，已被 git 忽略），`config.toml` 中 `[auth.external.google]` 已是 `enabled = true`，然后执行 `npx supabase config diff` 核对、`npx supabase config push` 推送。推送会同时设置 Site URL 和 Redirect URLs（`https://*.chromiumapp.org/**`，扩展登录后的跳回地址），不会改动 `config.toml` 中没有声明的云端设置。也可以在后台手动设置：Authentication → Sign In / Providers → Google 填入 Client ID 和 Secret；Authentication → URL Configuration 的 Redirect URLs 加入上面的地址。本地：见 [本地运行指南](local-dev.md) 的 Google 登录一节。

扩展的跳回地址形如 `https://<扩展 ID>.chromiumapp.org/supabase`，由 Chrome 的 `chrome.identity.getRedirectURL()` 生成；开发版的扩展 ID 随加载目录变化，所以允许列表使用通配符。

---

## 三、准备 Stripe

**第一步，开启测试模式。** 登录 [dashboard.stripe.com](https://dashboard.stripe.com)，右上角打开 “Test mode”。

**第二步，创建产品和价格。** 推荐直接运行脚本（读取 `supabase/functions/.env` 中的 `STRIPE_SECRET_KEY`，可重复执行，已存在的不会重复创建）：

```bash
python3 scripts/setup_stripe.py
```

脚本会创建两个产品、三个价格和客户门户配置，并把 ID 写回 `.env`：

| 产品 | 价格 | lookup_key | 环境变量 |
| --- | --- | --- | --- |
| 微光翻译 Premium | $29 / 年 | `glimmer_premium_yearly` | `STRIPE_PRICE_PREMIUM_YEARLY` |
| 微光翻译 Premium+ | $6 / 月 | `glimmer_plus_monthly` | `STRIPE_PRICE_PLUS_MONTHLY` |
| 微光翻译 Premium+ | $69 / 年 | `glimmer_plus_yearly` | `STRIPE_PRICE_PLUS_YEARLY` |

也可以在后台 Product catalog 手动创建，金额和周期按上表填写。

**第三步，客户门户。** 脚本已创建门户配置（`STRIPE_PORTAL_CONFIGURATION`，允许取消订阅、在三个价格之间升级或切换、改卡、下载发票）。手动配置时在 Settings → Billing → Customer portal 中开启同样的选项，并把三个价格都加入“可切换的产品”。

**第四步，记下密钥。** Developers → API keys：复制 Secret key（`sk_test_…`）。

**第五步，配置 webhook。** Developers → Webhooks → Add endpoint：

- Endpoint URL：`https://<项目 ID>.supabase.co/functions/v1/stripe-webhook`
- 选择 4 个事件：`checkout.session.completed`、`customer.subscription.created`、`customer.subscription.updated`、`customer.subscription.deleted`
- 保存后复制 Signing secret（`whsec_…`）

---

## 四、部署 Edge Functions

**第一步，设置密钥。** 这些值只保存在 Supabase 服务端：

```bash
npx supabase secrets set \
  STRIPE_SECRET_KEY=sk_test_xxx \
  STRIPE_WEBHOOK_SECRET=whsec_xxx \
  STRIPE_PRICE_PREMIUM_YEARLY=price_xxx \
  STRIPE_PRICE_PLUS_MONTHLY=price_xxx \
  STRIPE_PRICE_PLUS_YEARLY=price_xxx \
  STRIPE_PORTAL_CONFIGURATION=bpc_xxx
```

再设置翻译服务商的 Key（只填你打算提供的引擎；没有 Key 的引擎会提示“服务端尚未配置 … 的 API Key”）：

```bash
npx supabase secrets set \
  DEEPL_API_KEY=xxx \
  AZURE_TRANSLATOR_KEY=xxx AZURE_TRANSLATOR_REGION=eastasia \
  OPENAI_API_KEY=sk-xxx GEMINI_API_KEY=xxx DEEPSEEK_API_KEY=sk-xxx ANTHROPIC_API_KEY=sk-ant-xxx
```

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `DEEPL_API_KEY` | DeepL，Key 以 `:fx` 结尾时自动使用 Free 接口 | — |
| `AZURE_TRANSLATOR_KEY`、`AZURE_TRANSLATOR_REGION` | Microsoft 翻译（Azure Translator，F0 免费层每月 200 万字符） | — |
| `OPENAI_API_KEY`、`OPENAI_MODEL` | GPT | `gpt-4.1-mini` |
| `GEMINI_API_KEY`、`GEMINI_MODEL` | Gemini | `gemini-2.5-flash` |
| `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL` | DeepSeek | `deepseek-chat` |
| `ANTHROPIC_API_KEY`、`CLAUDE_MODEL` | Claude | `claude-haiku-5-5` |
| `POINT_LIMIT_MONTHLY` | Premium+ 每月 AI 点数（1 点 = Claude Haiku 1 个 Token，其他模型按成本加权） | `15000000` |
| `CHAR_LIMIT_PREMIUM` / `CHAR_LIMIT_PLUS` | DeepL、Microsoft 合计的每月字符上限 | `100000` / `200000` |
| `DISABLED_ENGINES` | 暂不开放的引擎，逗号分隔（返回“即将开放”） | `openai,gemini` |
| `DEEPSEEK_MODEL` | DeepSeek 模型 | `deepseek-flash` |

各家 Key 的申请方式：[DeepL API](https://www.deepl.com/pro-api)、[Azure 门户](https://portal.azure.com) 搜索 Translator、[OpenAI](https://platform.openai.com/api-keys)、[Google AI Studio](https://aistudio.google.com/apikey)、[DeepSeek](https://platform.deepseek.com)、[Anthropic Console](https://console.anthropic.com)。

`SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY` 由平台自动注入，不需要手动设置。可选的 `STRIPE_PORTAL_CONFIGURATION`（`bpc_…`）指定客户门户配置，适合不方便在后台保存默认门户设置时，用 `stripe billing_portal configurations create` 创建后填入。可选的 `PUBLIC_SUPABASE_URL` 用于拼接支付返回页地址，云端不需要设置，只在本地运行时需要（见本地运行指南）。

**第二步，部署 5 个函数。**

```bash
npx supabase functions deploy translate
npx supabase functions deploy billing-checkout
npx supabase functions deploy billing-portal
npx supabase functions deploy stripe-webhook --no-verify-jwt
npx supabase functions deploy billing-return --no-verify-jwt
npx supabase functions deploy check-email --no-verify-jwt
```

`stripe-webhook` 和 `billing-return` 必须加 `--no-verify-jwt`：前者由 Stripe 调用（靠 Stripe 签名验证身份），后者是浏览器直接打开的页面。`supabase/config.toml` 中已经写了同样的设置。

---

## 五、配置扩展

编辑 `src/shared/config.js`：

```js
export const BACKEND = {
  supabaseUrl: 'https://xxxx.supabase.co',
  supabaseAnonKey: 'eyJhbGciOi...',
};
```

在 `chrome://extensions` 中重新加载扩展。打开面板 → 设置 → 账户，看到登录表单即表示连接成功。

> **当前部署：** 云端项目“glimmer”（`btaihodwxgyhtbyjhbke`，美国东部）已完成上述全部步骤：两份迁移、5 个函数、9 个密钥、Stripe 沙盒 webhook（`/functions/v1/stripe-webhook`）、Google 登录（Web application 类型的 OAuth 客户端）、Site URL 与扩展跳回地址，`config.js` 已填写。`publishable` 公开密钥可以提交到仓库，`secret` / `service_role` 密钥不可以。

**数据库直连失败时。** `db.<项目 ID>.supabase.co` 只有 IPv6 地址，在只支持 IPv4 的网络里 `supabase db push` 会报 `failed to connect to postgres`。可以改用管理接口执行迁移，不需要数据库密码：

```bash
npx supabase db query --remote --yes -f supabase/migrations/<迁移文件>.sql
```

**关联云端后本地启动变慢。** `supabase link` 会在 `supabase/.temp/` 写入云端的组件版本（`postgres-version`、`storage-version` 等），之后 `supabase start` 会去下载这些版本的镜像，而且数据库版本变化可能与本地已有数据不兼容。只想保持本地原样时，删除这几个 `*-version` 文件和 `storage-migration`，保留 `project-ref`。

**邮件发送限制。** Supabase 自带的邮件服务每小时只能发很少几封，且只发给项目团队成员的邮箱（用自己的账号测试没问题）。给其他用户开放注册前，必须在 Authentication → Emails → SMTP Settings 接入自己的邮件服务（如 Resend、SendGrid），否则其他人注册时收不到验证邮件。

---

## 六、跑通一次完整流程

| 步骤 | 操作 | 预期 |
| --- | --- | --- |
| 1 | 面板 → 设置 → 账户 → 注册 | 提示“验证邮件已发送” |
| 2 | 点击邮件中的验证链接，回到面板登录 | 显示邮箱和“免费版” |
| 3 | 面板首页右上角“Premium” → 方案页切到“月付方案” → “开通 Premium+” | 新标签页打开 Stripe 支付页 |
| 4 | 用测试卡 `4242 4242 4242 4242`，任意未来日期、任意 CVC 付款 | 跳到“订阅成功”页面 |
| 5 | 回到面板 | 几秒内变为“Premium+ 会员”，显示下次续费日期、本月 AI 点数与 DeepL / Microsoft 字符用量，右上角变为实心“Premium+” |
| 6 | 设置 → 翻译引擎选 DeepSeek，翻译一个网页 | 译文正常；账户页本月用量增加，`usage_monthly` 有记录 |
| 7 | 收藏一个生词 | `words` 表出现该词（Premium 及以上自动同步） |
| 8 | 点击“管理订阅” → 取消订阅 | 回到面板后显示“已取消续费，Premium+ 有效期至……” |
| 9 | 在 Stripe 后台把该订阅立即取消 | 面板刷新后变回“免费版” |

在 Supabase 后台 Table Editor 中可以看到 `profiles`、`subscriptions` 的对应变化；Edge Functions → stripe-webhook → Logs 中能看到每个事件的处理结果。

**本地调试 webhook**（可选）：Stripe CLI 可以把事件转发到任意地址，并手动触发事件：

```bash
stripe listen --forward-to https://<项目 ID>.supabase.co/functions/v1/stripe-webhook
stripe trigger customer.subscription.updated
```

---

## 七、上线前检查

- [ ] Stripe 切换到正式模式，重新创建产品价格、webhook，用正式的 `sk_live_…`、`whsec_…`、`price_…` 重新执行 `secrets set`
- [ ] 各翻译服务商的正式 Key 已设置，并在服务商后台设置用量上限或告警，防止异常消耗
- [ ] 根据大模型成本核对 `TOKEN_LIMIT_MONTHLY` 与 Premium+ 价格
- [ ] 配置自己的 SMTP 邮件服务，修改验证邮件、重置密码邮件的模板为中文
- [ ] Supabase 项目开启数据库备份
- [ ] 隐私政策中说明：会收集邮箱用于登录，支付信息由 Stripe 处理，扩展和我们的服务器不接触银行卡信息
- [ ] Chrome 应用商店的隐私说明中勾选“个人身份信息（邮箱）”“财务与支付信息（由 Stripe 处理）”

---

## 八、常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 账户页显示“账户服务尚未配置” | `src/shared/config.js` 没填，或填完没有重新加载扩展 |
| 注册提示“操作太频繁” | Supabase 默认邮件服务的频率限制，配置自己的 SMTP |
| 点击“开通”提示“缺少环境变量 STRIPE_PRICE_…” | 第四部分的 `secrets set` 没有执行或拼写错误 |
| 会员翻译提示“服务端尚未配置 … 的 API Key” | 该引擎对应的服务商 Key 没有设置（`translate` 函数返回 503），见第四部分 |
| Premium+ 提示“本月 AI 点数已用完” | 已达到 `POINT_LIMIT_MONTHLY`；下月 1 日（UTC）自动清零，测试时可删除 `usage_monthly` 中对应行 |
| 提示“本月 DeepL / Microsoft 翻译额度已用完” | 已达到 `CHAR_LIMIT_PREMIUM` / `CHAR_LIMIT_PLUS`；同上 |
| 支付成功但一直是免费版 | 检查 Stripe 后台 webhook 的发送记录：401 说明部署时漏了 `--no-verify-jwt`；400 说明 `STRIPE_WEBHOOK_SECRET` 不对；500 查看函数日志 |
| 点击“管理订阅”报错 | Stripe 后台没有保存客户门户设置（第三部分第三步） |
| 测试时想重置某个用户为免费版 | 在 SQL Editor 执行 `update profiles set plan='free' where email='…'`，或在 Stripe 后台取消其订阅 |

---

## 九、会员等级判断

等级定义在 `src/shared/settings.js`（`ENGINES` 的 `tier`、`canUse`）和 `supabase/functions/_shared/translate.ts`（`ENGINE_TIER`、`checkAccess`），两边需保持一致。扩展的判断只用于界面提示（标注等级、打开方案页）；真正的校验在后端：

- `translate` 函数从 `profiles.plan` 读取等级，等级不够返回 403（`upgrade`），Premium+ 本月用量超过额度返回 429（`quota`），单次超过 100 段或 2 万字符返回 413
- `words` 表的 RLS 只允许 `is_member(uid)` 为真的用户读写
- 生词本 100 个的免费上限在扩展后台（`toggleWord`）执行，属于本地功能限制

## 十、成本测算（2026-11-24，发布计划 2.1）

定价是否赚钱，取决于每个引擎每翻译一段文字要付多少钱。下表价格取自各家官网或官方资料，2026-11-24 核对；**DeepL、Microsoft 的官网价格页未能直接读到，数字来自多个一致的二手来源，上线前需在各自后台再确认一次。**

### 10.1 各引擎单价

| 引擎 | 后端使用的模型 | 计费 | 单价 | 来源 |
| --- | --- | --- | --- | --- |
| DeepSeek | `deepseek-flash`（默认，2026-11-24 起；原为 `deepseek-chat`） | 按 Token | 现行型号 `deepseek-flash`：输入 $0.30 / 输出 $1.20 每百万 Token（高峰）；非高峰（UTC 01–04、06–10 点之外）半价；缓存命中输入 $0.006 | [DeepSeek 官方价格页](https://api-docs.deepseek.com/quick_start/pricing) |
| OpenAI | `gpt-4.1-mini` | 按 Token | 输入 $0.40 / 输出 $1.60 每百万 Token | [OpenAI 模型页](https://developers.openai.com/api/docs/models/gpt-4.1-mini) |
| Gemini | `gemini-2.5-flash` | 按 Token | 输入 $0.30 / 输出 $2.50 每百万 Token | [Google AI 价格页](https://ai.google.dev/gemini-api/docs/pricing) |
| Claude | `claude-haiku-5-5` | 按 Token | 输入 $0.10 / 输出 $0.50 每百万 Token（单次 10 万 Token 以内） | Anthropic 官方模型价格表 |
| DeepL | DeepL API Pro | 按字符 | $25 每百万字符，另有每月基础费 $5.49 | [DeepL 计费说明](https://support.deepl.com/hc/en-us/articles/360020685720-Usage-count-and-billing-in-DeepL-API)、[AWS Marketplace](https://aws.amazon.com/marketplace/pp/prodview-2fii5e2hmuneo) |
| Microsoft | Azure Translator S1 | 按字符 | 约 $10 每百万字符；每月前 200 万字符免费（F0 免费层） | [Azure Translator 价格页](https://azure.microsoft.com/en-us/pricing/details/translator/)（S1 价格未显示，取自旧版页面与官方问答） |

> **已处理：** 原默认的 `deepseek-chat` 已不在 DeepSeek 官方价格表中，2026-11-24 起默认改为 `deepseek-flash`（决策 D4）。

### 10.2 收入（扣除 Stripe 手续费 2.9% + $0.30 后）

| 方案 | 每用户每月净收入 |
| --- | --- |
| Premium（$29 / 年） | $2.32 |
| Premium+ 月付（$6 / 月） | $5.53 |
| Premium+ 年付（$69 / 年） | $5.56 |

未计入 Supabase、域名、邮件等固定成本与税费。

### 10.3 Premium+：用满每月 2000 万 Token 的成本

假设翻译时输入（提示词 + 原文）约占 55%、输出（译文）约占 45%。

| 引擎 | 每百万 Token 综合成本 | 用满 2000 万 Token | 月付打平的用量 |
| --- | --- | --- | --- |
| Claude Haiku 5.5 | $0.28 | $5.60 | 1970 万 Token |
| DeepSeek（非高峰） | $0.35 | $7.05 | 1570 万 Token |
| DeepSeek（高峰） | $0.71 | $14.10 | 780 万 Token |
| GPT-4.1 mini | $0.94 | $18.80 | 590 万 Token |
| Gemini 2.5 Flash | $1.29 | $25.80 | 430 万 Token |

**结论：用满额度时，只有 Claude Haiku 大致打平，其余都亏；Gemini 每个重度用户每月亏约 $20。** 大多数用户用不满，但额度是按最贵的引擎开放的。

### 10.4 Premium：DeepL 没有任何上限，是最大的亏损点

| 引擎 | 打平的用量（Premium 每月） | 翻译 100 万字符的成本 |
| --- | --- | --- |
| DeepL | 约 9.3 万字符（十几篇英文长文） | $25 |
| Microsoft | 约 23 万字符 | $10 |
| 对比：大模型 | — | 约 60 万 Token：Claude Haiku ≈ $0.17、DeepSeek ≈ $0.21–0.42、GPT-4.1 mini ≈ $0.56 |

DeepL、Microsoft 目前只记录字符数、不设上限，Premium+ 用户的 DeepL 也不计入 Token 额度。**按字符计费的机器翻译比大模型贵 25–150 倍**，一个每天翻几篇长文的 Premium 用户每月就可能让我们亏 $10 以上。

### 10.5 建议（供决策 D1、D4 参考）

1. **给 DeepL、Microsoft 设每月字符上限**（发布计划 2.3）：如 Premium 每月 10 万字符、Premium+ 每月 20 万字符，用完后自动改用大模型或 Google，提示方式与“AI 额度用完”一致
2. **Premium+ 改为按引擎加权的“AI 点数”**（D1 方案 ②）：以 Claude Haiku 为 1 倍，DeepSeek 约 2.5 倍，GPT-4.1 mini 约 3.4 倍，Gemini 约 4.6 倍；每月点数按“用满不亏”设定
3. **首发引擎（D4）优先选便宜的大模型**：Claude Haiku 5.5、DeepSeek；Gemini 2.5 Flash 输出价格最高，可以晚开
4. **把 DeepSeek 默认模型改为 `deepseek-flash`**。用户什么时候翻译无法控制，测算时按高峰价更稳妥
5. 上线后用 `usage_monthly` 的真实数据（字符数、Token 数）每月复核一次，再调整额度

### 10.6 已采用的方案（2026-11-24，决策 D1、D4 与 2.3）

| 项 | 方案 | 用满时的成本 |
| --- | --- | --- |
| Premium+ AI 点数 | 每月 1500 万点；Claude 1 倍、DeepSeek 2.5 倍、GPT 3.4 倍、Gemini 4.6 倍（`ENGINE_WEIGHT`） | 任何引擎约 $4.2（净收入 $5.53） |
| DeepL / Microsoft 字符 | Premium 每月 10 万字符、Premium+ 20 万字符，两者合计；用完自动改用 Google | 全用 DeepL 时 Premium $2.5、Premium+ $5 |
| 首发引擎 | Google、DeepL、Microsoft、DeepSeek（`deepseek-flash`）、Claude；GPT、Gemini 即将开放（`DISABLED_ENGINES`） | — |

**仍有的风险：** Premium 用满 DeepL 时成本（$2.5）略高于净收入（$2.32）；Premium+ 同时用满点数与 DeepL 时最坏约 $9。大多数用户用不满，上线后按 `usage_monthly` 的真实分布调整——三个额度都是环境变量，改 `supabase secrets` 即可，不用改代码或发新版本插件（插件显示的上限以后端返回为准）。
