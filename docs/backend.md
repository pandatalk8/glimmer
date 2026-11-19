# 后端部署指南：Supabase + Stripe

账户和订阅功能需要一个后端。整套后端只用两家服务：**Supabase** 负责注册登录和数据库，**Stripe** 负责收款。代码都在仓库的 `supabase/` 目录，照着下面的步骤做一遍，大约 30 分钟。

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
返回页 billing-return ──扩展检测到后刷新会员状态◀── 数据库 plan = 'pro'
```

| 目录 / 文件 | 作用 |
| --- | --- |
| `supabase/migrations/…_accounts_billing.sql` | 建表：`profiles`（会员状态）、`subscriptions`（订阅明细）、`stripe_events`（事件去重），以及行级权限和注册触发器 |
| `supabase/functions/billing-checkout` | 创建 Stripe 订阅支付页，需要登录 |
| `supabase/functions/billing-portal` | 打开 Stripe 客户门户（换方案、改卡、取消、发票），需要登录 |
| `supabase/functions/stripe-webhook` | 接收 Stripe 事件，验证签名后同步会员状态 |
| `supabase/functions/billing-return` | 支付完成 / 取消后显示的返回页 |
| `supabase/functions/_shared/billing.ts` | 订阅同步的核心逻辑，有单元测试 |
| `src/shared/config.js` | 扩展里填写 Supabase 地址和 anon key |

**会员状态只由后端写入。** 用户在数据库里只有“读自己那一行”的权限，无法把自己改成 Pro。

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
- Authentication → URL Configuration 的 Site URL 填你的官网或任意你控制的网址，验证邮件和重置密码邮件中的链接会跳到这里
- 默认的邮件发送有频率限制（每小时几封），正式上线前在 Authentication → Emails → SMTP Settings 配置自己的邮件服务

**第四步，建表。** 安装命令行工具后关联项目并推送迁移：

```bash
npx supabase login
npx supabase link --project-ref <你的 Project Reference ID>
npx supabase db push
```

`db push` 会执行 `supabase/migrations/` 中的 SQL。也可以把 SQL 文件内容粘贴到后台 SQL Editor 中执行，效果相同。

---

## 三、准备 Stripe

**第一步，开启测试模式。** 登录 [dashboard.stripe.com](https://dashboard.stripe.com)，右上角打开 “Test mode”。

**第二步，创建产品和价格。** Product catalog → Add product：

- 名称：微光翻译 Pro
- 添加两个**循环（Recurring）**价格：每月、每年，金额自定
- 保存后记下两个价格 ID（`price_…`）

**第三步，开启客户门户。** Settings → Billing → Customer portal：打开“允许取消订阅”“允许更换方案”（把月付、年付两个价格都加入），保存。

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
  STRIPE_PRICE_MONTHLY=price_xxx \
  STRIPE_PRICE_YEARLY=price_xxx
```

`SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY` 由平台自动注入，不需要手动设置。可选的 `STRIPE_PORTAL_CONFIGURATION`（`bpc_…`）指定客户门户配置，适合不方便在后台保存默认门户设置时，用 `stripe billing_portal configurations create` 创建后填入。可选的 `PUBLIC_SUPABASE_URL` 用于拼接支付返回页地址，云端不需要设置，只在本地运行时需要（见本地运行指南）。

**第二步，部署 4 个函数。**

```bash
npx supabase functions deploy billing-checkout
npx supabase functions deploy billing-portal
npx supabase functions deploy stripe-webhook --no-verify-jwt
npx supabase functions deploy billing-return --no-verify-jwt
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

---

## 六、跑通一次完整流程

| 步骤 | 操作 | 预期 |
| --- | --- | --- |
| 1 | 面板 → 设置 → 账户 → 注册 | 提示“验证邮件已发送” |
| 2 | 点击邮件中的验证链接，回到面板登录 | 显示邮箱和“免费版” |
| 3 | 点击“月付” | 新标签页打开 Stripe 支付页 |
| 4 | 用测试卡 `4242 4242 4242 4242`，任意未来日期、任意 CVC 付款 | 跳到“订阅成功”页面 |
| 5 | 回到面板 | 几秒内变为“Pro 会员”，显示下次续费日期，标题栏出现金色 Pro 标识 |
| 6 | 点击“管理订阅” → 取消订阅 | 回到面板后显示“已取消续费，Pro 有效期至……” |
| 7 | 在 Stripe 后台把该订阅立即取消 | 面板刷新后变回“免费版” |

在 Supabase 后台 Table Editor 中可以看到 `profiles`、`subscriptions` 的对应变化；Edge Functions → stripe-webhook → Logs 中能看到每个事件的处理结果。

**本地调试 webhook**（可选）：Stripe CLI 可以把事件转发到任意地址，并手动触发事件：

```bash
stripe listen --forward-to https://<项目 ID>.supabase.co/functions/v1/stripe-webhook
stripe trigger customer.subscription.updated
```

---

## 七、上线前检查

- [ ] Stripe 切换到正式模式，重新创建产品价格、webhook，用正式的 `sk_live_…`、`whsec_…`、`price_…` 重新执行 `secrets set`
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
| 点击月付提示“缺少环境变量 STRIPE_PRICE_MONTHLY” | 第四部分的 `secrets set` 没有执行或拼写错误 |
| 支付成功但一直是免费版 | 检查 Stripe 后台 webhook 的发送记录：401 说明部署时漏了 `--no-verify-jwt`；400 说明 `STRIPE_WEBHOOK_SECRET` 不对；500 查看函数日志 |
| 点击“管理订阅”报错 | Stripe 后台没有保存客户门户设置（第三部分第三步） |
| 测试时想重置某个用户为免费版 | 在 SQL Editor 执行 `update profiles set plan='free' where email='…'`，或在 Stripe 后台取消其订阅 |

---

## 九、Pro 会员判断

扩展后台提供 `isPro()`（`src/background/account.js`），读取本地缓存的会员状态。缓存在打开面板、进入账户页、支付返回时刷新。需要收费的功能在后台调用它判断即可；涉及服务端资源的功能（例如由我们提供的 AI 翻译额度），应当在 Edge Function 中根据 `profiles.plan` 再次校验，不能只信任扩展本地的判断。
