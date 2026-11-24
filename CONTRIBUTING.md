# 参与贡献 / Contributing

感谢你愿意改进微光翻译！问题反馈、文档修正、代码改动都欢迎。

Thanks for helping improve Glimmer! Issues, docs fixes and pull requests are all welcome. Discussions in English or Chinese are both fine.

## 先跑起来

扩展本身是原生 JavaScript，**没有构建步骤**：

1. 克隆仓库，在 Chrome 打开 `chrome://extensions`，开启“开发者模式”，点“加载已解压的扩展程序”，选择仓库根目录
2. 免费功能（Google 翻译、整页 / 划词 / 悬停 / 输入框翻译、YouTube 字幕、生词本）不需要任何后端
3. 账户、会员与付费引擎需要 Supabase 后端：本地开发见 [docs/local-dev.md](docs/local-dev.md)，自建部署见 [docs/backend.md](docs/backend.md)。不要连接别人的云端后端做开发

## 提交改动前

- 运行测试（需要 Python 3 与 Playwright：`pip install playwright && playwright install chromium`）：

  ```bash
  python3 tests/e2e.py          # 核心回归
  python3 tests/e2e_real.py     # 真实网站与交互（需要联网）
  deno test --allow-env --allow-net --allow-read supabase/functions/   # 涉及 supabase/ 时
  ```

- 改动用户能感受到的功能时，同步更新：
  - `CHANGELOG.md` 的“未发布”部分（从用户能感受到的变化写起）
  - `docs/test-cases.md` 中对应的用例（预期文字以代码中的实际文案为准）
  - 架构变化时更新 `docs/architecture.md`，并运行 `python3 tests/check_diagrams.py`
- 界面各区域的叫法见 [docs/ui-terms.md](docs/ui-terms.md)
- 中文文档使用全角引号“”‘’（代码块除外）

## 绝对不要提交

- 任何密钥：Stripe（`sk_…`、`whsec_…`）、`service_role` / `sb_secret_…`、翻译服务商的 API Key、OAuth Client Secret
- `supabase/functions/.env`、`supabase/.env` 等环境变量文件（已被 `.gitignore` 忽略，复制 `*.env.example` 填写）

`python3 scripts/package.py` 打包时会自动扫描密钥。

## Pull Request

- 一个 PR 做一件事，描述里写清“改了什么、为什么、怎么验证的”
- 修复问题时尽量附一条能复现问题的测试（修复前失败、修复后通过）
- 引擎的会员等级在 `src/shared/settings.js` 与 `supabase/functions/_shared/translate.ts` 两处定义，必须保持一致

## 行为准则

参与本项目即表示你同意遵守 [行为准则](CODE_OF_CONDUCT.md)。
