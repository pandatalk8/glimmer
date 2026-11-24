# 安全策略 / Security Policy

## 报告安全问题

**请不要在公开的 Issue 中报告安全漏洞。**

请通过 GitHub 的私密漏洞报告提交：仓库页面 → **Security** → **Report a vulnerability**。我们会在 7 天内回复，确认问题后尽快修复，并在修复发布后致谢（如果你愿意署名）。

Please report vulnerabilities privately via GitHub: **Security → Report a vulnerability**. Do not open a public issue.

## 范围

特别欢迎以下方面的报告：

- 越权：普通用户修改自己的会员等级、用量，或读写他人的生词本（数据库行级安全 RLS）
- 翻译代理被滥用：未登录或低等级账户调用付费引擎、绕过每月额度
- 支付回调伪造：未经 Stripe 签名的通知改变会员状态
- 扩展把服务商 API Key、`service_role` 等服务端密钥带到浏览器中
- 内容脚本在网页中被利用（XSS、跨扩展消息伪造等）

`tests/security_cloud.py` 是现有的越权与密钥检查，可以作为参考。

## 设计上的约定

- 扩展中只放 Supabase 的**公开** key（`sb_publishable_…` / anon key），数据安全依靠 RLS
- 服务商 API Key、Stripe 密钥、`service_role` key 只放在 `supabase/functions/.env`（已被 git 忽略）或 `supabase secrets` 中
- 会员状态与用量只能由 Edge Functions（service role）写入
