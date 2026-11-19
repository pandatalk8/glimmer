# 本地运行指南

在自己的电脑上把微光翻译跑起来，有三种程度，按需要选：

| 方式 | 能做什么 | 需要什么 | 用时 |
| --- | --- | --- | --- |
| **一、只运行扩展** | 网页翻译、划词、字幕、生词本、侧面板，以及所有不需要账户的功能 | Chrome | 5 分钟 |
| **二、运行自动化测试** | 验证改动没有破坏功能；账户与订阅用模拟接口测试 | Python、Playwright、Deno | 10 分钟 |
| **三、本地完整后端** | 在本机真实地注册登录、用 Stripe 测试卡付款、变为 Pro | Docker Desktop、Stripe 账号 | 30 分钟 |

大部分时候方式一就够了。只有要改动账户、订阅相关代码时，才需要方式三。

---

## 一、准备工具

| 工具 | 用于 | 检查是否已安装 | 安装 |
| --- | --- | --- | --- |
| Chrome 111+ | 运行扩展 | 地址栏打开 `chrome://version` | — |
| Git | 获取代码 | `git --version` | `brew install git` |
| Python 3 + Playwright | 自动化测试 | `python3 -c "import playwright"` | `pip3 install playwright && python3 -m playwright install chromium` |
| Deno | 后端单元测试、本地函数检查 | `deno --version` | `brew install deno` |
| Docker Desktop | 本地运行 Supabase（方式三） | `docker info` 不报错 | [docker.com](https://www.docker.com/products/docker-desktop/) 下载安装 |
| Node.js（npx） | 运行 Supabase CLI，不用全局安装 | `npx --version` | `brew install node` |
| Stripe CLI | 本地接收支付通知（方式三） | `stripe --version` | `brew install stripe/stripe-cli/stripe` |

---

## 二、方式一：只运行扩展

**第一步，获取代码。** 日常检查我的改动用本地 `dev` 分支：

```bash
cd /Users/wanghe/workspace/translator
git checkout dev
git merge --ff-only worktree-immersive-translator   # 拉入最新改动
```

**第二步，加载扩展。**

1. Chrome 打开 `chrome://extensions`，右上角开启“开发者模式”
2. 点击“加载已解压的扩展程序”，选择 `/Users/wanghe/workspace/translator`（包含 `manifest.json` 的目录）
3. 点击工具栏的拼图图标，把“微光翻译”固定到工具栏

**第三步，试用。** 打开任意英文网页，点击工具栏图标滑出侧面板，打开“翻译此页面”。Google 翻译开箱即用，不需要任何配置。

**第四步（可选），配置翻译引擎。** 面板 → 设置 → API Key，在完整设置页的“翻译服务”中填入 DeepL、DeepSeek 等 Key，点击“测试连接”。各家 Key 的获取方式见 [配置指南](configuration.md)。

**改了代码之后：**

| 改动的文件 | 需要做什么 |
| --- | --- |
| `src/background/**`、`src/shared/**`、`manifest.json` | `chrome://extensions` 中点击扩展卡片的刷新按钮 |
| `src/content/**` | 刷新扩展，**并刷新网页** |
| `panel/**`、`options/**` | 关闭面板或设置页后重新打开 |

> 同时只保留一个微光翻译。如果之前从其他目录（比如 worktree）加载过，先在扩展页移除它，否则两个扩展会同时运行。

---

## 三、方式二：运行自动化测试

在项目根目录执行：

```bash
python3 tests/e2e.py              # 核心回归，约 1 分钟
python3 tests/e2e_real.py         # 真实网站与交互，约 2 分钟（需联网）
python3 tests/e2e_account.py      # 账户与订阅，用模拟的 Supabase，约 30 秒
deno test --allow-env --allow-net --allow-read supabase/functions/   # 后端订阅逻辑
python3 tests/check_diagrams.py   # 文档中的图能否正常渲染
```

用自己的 Key 测试翻译引擎：

```bash
cp tests/env.example tests/.env.local   # 已被 git 忽略
# 编辑 tests/.env.local，只填你有的 Key
python3 tests/e2e_engines.py
```

每个测试都会打印“结果：N/N 通过”，截图保存在 `tests/output/`。加 `--headed` 参数可以看到浏览器的操作过程。

---

## 四、方式三：本地完整后端

这一节让你在本机跑通真实的注册、登录和付款。所有服务都在本机，支付使用 Stripe 测试模式，不会产生真实扣款。

### 4.1 本地是怎么连起来的

```mermaid
flowchart LR
  EXT["Chrome 扩展<br/>backendOverride 指向本机"] -- "注册 · 登录 · 读会员状态" --> API["本地 Supabase<br/>127.0.0.1:54321"]
  API --- DB[("Postgres<br/>:54322")]
  API --- MAIL["Mailpit 邮箱<br/>:54324"]
  EXT -- "升级 / 管理订阅" --> FN["supabase functions serve<br/>本地 Edge Functions"]
  FN -- "创建支付页" --> STRIPE["Stripe 测试模式"]
  STRIPE -- "支付通知" --> CLI["stripe listen"]
  CLI -- "转发" --> FN
```

需要同时开 **3 个终端窗口**，各跑一个常驻进程：

| 终端 | 命令 | 作用 |
| --- | --- | --- |
| 1 | `npx supabase start`（启动后可关闭窗口，服务在 Docker 中继续运行） | 数据库、账户、邮箱 |
| 2 | `stripe listen --forward-to …` | 把 Stripe 的支付通知转发到本机 |
| 3 | `npx supabase functions serve …` | 运行 4 个 Edge Functions |

### 4.2 启动本地 Supabase

**第一步，打开 Docker Desktop**，等菜单栏的鲸鱼图标显示“running”。

**第二步，在项目根目录启动：**

```bash
cd /Users/wanghe/workspace/translator
npx supabase start
```

首次运行会下载镜像，需要几分钟。完成后会打印一组地址和密钥，记下这几项：

| 输出中的名称 | 示例 | 用在哪 |
| --- | --- | --- |
| API URL | `http://127.0.0.1:54321` | 扩展的后端地址 |
| anon key（或 Publishable key） | `eyJhbGciOi…` 或 `sb_publishable_…` | 扩展的公开密钥，两种格式都可以 |
| Studio URL | `http://127.0.0.1:54323` | 网页版数据库管理，查看用户和会员状态 |
| Inbucket / Mailpit URL | `http://127.0.0.1:54324` | 本地邮箱，验证邮件、重置密码邮件都在这里 |

之后随时可以用 `npx supabase status` 再次查看。

**数据库表会自动创建**：`supabase start` 会执行 `supabase/migrations/` 中的建表语句。想清空数据重来时执行 `npx supabase db reset`。

### 4.3 准备 Stripe 测试数据

**第一步，登录 Stripe CLI：**

```bash
stripe login
```

浏览器会打开授权页面，确认后回到终端。CLI 默认使用你账号的测试模式。

**最快的方式：一条命令完成第二、三步。** 先在 `supabase/functions/.env` 填好 `STRIPE_SECRET_KEY`，然后执行：

```bash
python3 scripts/setup_stripe.py
```

脚本会创建产品、月付 5 美元 / 年付 48 美元两个价格、客户门户配置，并把编号写入 `.env`。可以重复执行，已存在的会直接复用。想手动创建的话，按下面两步：

**第二步，创建产品和两个价格**（金额只是示例，单位为分）：

```bash
stripe products create -d name="微光翻译 Pro"
# 记下返回的 id：prod_xxx

stripe prices create -d product=prod_xxx -d unit_amount=500 -d currency=usd -d "recurring[interval]=month"
stripe prices create -d product=prod_xxx -d unit_amount=4800 -d currency=usd -d "recurring[interval]=year"
# 分别记下两个 id：price_xxx
```

也可以在 Stripe 后台（右上角打开 Test mode）手动创建，效果相同。

**第三步，创建客户门户配置**（“管理订阅”需要）。用命令直接创建，不必去后台找设置页：

```bash
stripe billing_portal configurations create \
  -d "features[subscription_cancel][enabled]=true" \
  -d "features[payment_method_update][enabled]=true" \
  -d "features[invoice_history][enabled]=true" \
  -d "business_profile[headline]=微光翻译 Pro"
# 记下返回的 id：bpc_xxx，填入 .env 的 STRIPE_PORTAL_CONFIGURATION
```

也可以在 Stripe 后台保存默认的客户门户设置（Settings → Billing → Customer portal；沙盒账号的菜单位置可能不同，可在后台顶部搜索“customer portal”），这样就不用填 `STRIPE_PORTAL_CONFIGURATION`。

**第四步，在终端 2 转发支付通知（保持运行）：**

```bash
stripe listen --forward-to http://127.0.0.1:54321/functions/v1/stripe-webhook
```

启动后会打印 `Your webhook signing secret is whsec_…`，记下它。

### 4.4 运行 Edge Functions

**第一步，创建本地密钥文件** `supabase/functions/.env`（已被 git 忽略，不会提交）：

```bash
STRIPE_SECRET_KEY=sk_test_xxx            # stripe 后台 Developers → API keys 的 Secret key
STRIPE_WEBHOOK_SECRET=whsec_xxx          # 上一步 stripe listen 打印的值
STRIPE_PRICE_MONTHLY=price_xxx
STRIPE_PRICE_YEARLY=price_xxx
PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
STRIPE_PORTAL_CONFIGURATION=bpc_xxx       # 4.3 第三步创建的客户门户配置（可选）
```

`PUBLIC_SUPABASE_URL` 只在本地需要：函数在 Docker 容器里看到的地址是 `http://kong:8000`，浏览器打不开，支付完成后的返回页必须用本机地址。`SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY` 由 CLI 自动注入，不用填。

**第二步，在终端 3 启动函数（保持运行）：**

```bash
npx supabase functions serve --env-file supabase/functions/.env
```

`supabase/config.toml` 中已经为 `stripe-webhook`、`billing-return` 关闭了 JWT 校验，本地和云端行为一致。

### 4.5 让扩展连接本地后端

不需要修改 `src/shared/config.js`。在扩展后台写入一个覆盖地址即可：

1. 打开 `chrome://extensions`，在微光翻译卡片上点击“Service Worker”，打开后台的开发者工具
2. 在 Console 中执行（替换为你的 anon key 或 publishable key）：

```js
chrome.storage.local.set({
  backendOverride: { supabaseUrl: 'http://127.0.0.1:54321', supabaseAnonKey: '你的 anon key' },
});
```

3. 打开面板 → 设置 → 账户，看到登录表单即连接成功

### 4.6 跑通一遍

| 步骤 | 操作 | 预期结果 |
| --- | --- | --- |
| 1 | 账户页 → 注册，填写任意邮箱（如 `me@test.local`）和密码 | 提示“验证邮件已发送” |
| 2 | 打开 `http://127.0.0.1:54324`，点开验证邮件中的链接 | 验证成功后会跳到 `site_url`（示例网址打不开也没关系，验证已完成） |
| 3 | 回到面板登录 | 显示邮箱和“免费版” |
| 4 | 点击“月付” | 新标签页打开 Stripe 测试支付页 |
| 5 | 卡号 `4242 4242 4242 4242`，任意未来日期、任意 CVC、任意邮编，付款 | 跳到本机的“订阅成功”页面；终端 2 显示事件转发 `[200]` |
| 6 | 回到面板 | 几秒内变为“Pro 会员”，首页标题栏出现金色 Pro |
| 7 | 打开 Studio `http://127.0.0.1:54323` → Table Editor → `profiles` | 该用户的 `plan` 为 `pro` |
| 8 | 账户页 → 管理订阅 → 取消订阅 → 返回 | 显示“已取消续费，Pro 有效期至……” |

其他测试卡：`4000 0000 0000 0341`（绑定成功、续费时扣款失败，可测试 `past_due`）、`4000 0025 0000 3155`（需要 3D 验证）。

**自动跑一遍**：服务都启动后，执行 `python3 tests/e2e_local_billing.py`，会自动完成注册、邮箱验证、登录、付款、变为 Pro、到期取消，共 15 项检查。Stripe 支付页和客户门户是第三方页面，加载慢时自动化填写不稳定，脚本会改用 Stripe API 完成同样的付款与取消操作（输出中会注明），后续通知、数据库、扩展刷新的验证完全一致。

想直接模拟某个事件，不经过支付页：

```bash
stripe trigger customer.subscription.updated
```

### 4.7 用完之后

```bash
# 扩展切回 config.js 中的云端地址：在后台 Console 执行
chrome.storage.local.remove('backendOverride')

# 停止本地 Supabase（数据会保留，下次 start 继续使用）
npx supabase stop
```

终端 2、3 按 `Ctrl+C` 结束。

---

## 五、常见问题

| 现象 | 原因与处理 |
| --- | --- |
| `npx supabase start` 报 “Cannot connect to the Docker daemon” | Docker Desktop 没有启动，打开后等它显示 running |
| `supabase start` 报端口被占用 | 之前的实例没停：`npx supabase stop`，或在 Docker Desktop 中停止 `supabase_*` 容器 |
| 账户页提示“账户服务尚未配置” | 4.5 的 `backendOverride` 没写入，或写在了网页的 Console 而不是扩展后台的 Console |
| 注册提示“无法连接账户服务” | 本地 Supabase 没在运行，执行 `npx supabase status` 检查 |
| 收不到验证邮件 | 本地不会真的发邮件，去 `http://127.0.0.1:54324` 查看 |
| 点击“月付”提示“缺少环境变量” | `supabase/functions/.env` 缺项，或启动函数时没加 `--env-file` |
| 付款后跳转到 `http://kong:8000/…` 打不开 | `.env` 中没有设置 `PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`，补上后重启终端 3 |
| 付款成功但一直是免费版 | 看终端 2：没有事件说明 `stripe listen` 没在运行；显示 `[400]` 说明 `.env` 中的 `STRIPE_WEBHOOK_SECRET` 与 `stripe listen` 打印的不一致（每次重启 `stripe listen` 可能变化） |
| “管理订阅”报错 | 没有客户门户配置：按 4.3 第三步创建并填入 `STRIPE_PORTAL_CONFIGURATION`，或在 Stripe 后台保存默认设置 |
| 想把某个用户重置为免费版 | Studio 的 SQL Editor 执行 `update profiles set plan = 'free' where email = '…';` |

本地跑通后，部署到云端的步骤见 [后端部署指南](backend.md)。
