# CLAUDE.md

微光翻译 Glimmer：沉浸式双语翻译 Chrome 扩展（Manifest V3，原生 JavaScript，无构建步骤）。

## 更新日志（必须遵守）

**每一次修改都要记录到 `CHANGELOG.md`**，包括功能、修复、界面、文档、测试和配置的改动：

1. 改动写进 `CHANGELOG.md` 顶部的 `## [未发布]`，按“新功能 / 改进 / 修复 / 视觉 / 文档 / 测试 / 其他”分类
2. 从用户能感受到的变化写起，用中文，技术细节放在后面
3. 发布新版本时，把“未发布”改为 `## [版本号] - 日期`，同步修改 `manifest.json` 的 `version`，末尾注明对应提交，并新建一个空的“未发布”
4. 版本号：新增功能升次版本（0.2.0 → 0.3.0），只修问题升修订号（0.2.0 → 0.2.1）
5. 提交代码时，更新日志与代码改动放在同一个提交里

## 开发与发布计划（必须遵守）

`docs/release-plan.md` 是产品的开发与发布计划，每个决策、任务、版本都有状态：⏳ 未开始、🚧 进行中、✅ 已完成。**计划中的任何一项开始、完成或有变化时，在同一个提交里更新该文档**：改对应行的状态（进行中的写明卡在哪里），刷新开头“进度总览”的数字与“最后更新”，在文末“状态变更记录”加一行；甘特图中进行中的阶段标 `active`、完成的标 `done`。新增的工作如果属于计划范围，先补进计划再做。

## 测试用例（必须遵守）

`docs/test-cases.md` 是给测试人员的全旅程测试用例。**每次改动产品功能、交互逻辑、界面或文案，都要在同一个提交里同步更新测试用例**：预期结果中的文字以代码中的实际文案为准，新增的流程要补用例，删除的功能要删用例，避免用例落后于产品的真实样子。

## 常用命令

```bash
python3 tests/e2e.py          # 核心回归，36 项
python3 tests/e2e_real.py     # 真实网站与交互，75 项
python3 tests/e2e_account.py  # 账户与订阅（模拟 Supabase），62 项
deno test --allow-env --allow-net --allow-read supabase/functions/  # 后端订阅与翻译代理逻辑，19 项
python3 tests/e2e_local_billing.py  # 真实联调本地 Supabase + Stripe（需先启动本地后端），24 项
python3 tests/check_diagrams.py  # 文档中的 Mermaid 图能否正常渲染
python3 scripts/package.py    # 打包发布 zip，并自检引用、密钥，用打包后的插件跑核心回归
```

改动后至少运行前两项测试，全部通过再提交；涉及账户、订阅或 `supabase/` 时再运行账户测试和后端单元测试。

## 后端

`supabase/` 是 Supabase 项目（迁移 + Edge Functions），部署步骤见 `docs/backend.md`。会员状态和用量只能由 Edge Functions（service role）写入；service_role key、Stripe 密钥和翻译服务商的 Key 只放在 `supabase/functions/.env` 或 `supabase secrets` 中，绝不能写进扩展代码或提交到仓库。引擎的会员等级在 `src/shared/settings.js` 与 `supabase/functions/_shared/translate.ts` 两处定义，必须保持一致。

## 文档

架构、开发、配置、测试说明在 `docs/` 中；改动功能时同步更新相关文档。

架构图、时序图、数据表关系图用 Mermaid 写在 `docs/architecture.md` 中；架构变化时同步修改图，并运行 `tests/check_diagrams.py` 检查。

界面各区域的统一叫法见 `docs/ui-terms.md`（如“图标栏”“翻译开关卡片”“划词面板”），理解指令和汇报时都用这些名称；新增或改名界面元素时同步更新术语表。中文文档使用全角引号“”‘’，代码块除外。
