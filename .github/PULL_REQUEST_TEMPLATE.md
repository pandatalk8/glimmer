## 改了什么、为什么


## 怎么验证的

- [ ] `python3 tests/e2e.py` 通过
- [ ] 涉及真实网站或交互：`python3 tests/e2e_real.py` 通过
- [ ] 涉及 `supabase/`：`deno test --allow-env --allow-net --allow-read supabase/functions/` 通过

## 同步更新

- [ ] `CHANGELOG.md` 的“未发布”部分
- [ ] 改动了功能、界面或文案：`docs/test-cases.md` 中对应的用例
- [ ] 改动了引擎等级：`src/shared/settings.js` 与 `supabase/functions/_shared/translate.ts` 保持一致
- [ ] 没有提交任何密钥或 `.env` 文件
