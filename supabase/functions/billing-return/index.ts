// 支付完成 / 取消 / 退出订阅管理后的返回页，以及邮箱验证后的落地页（auth.site_url 指向 ?status=verified）。
// 扩展检测到此页面后会自动刷新账户状态。
const PAGES: Record<string, [string, string]> = {
  success: ['支付成功', '感谢支持！正在确认会员状态，几秒后自动回到微光翻译。'],
  cancel: ['已取消支付', '没有产生任何费用，正在回到微光翻译。'],
  portal: ['订阅设置已保存', '修改会在几秒内同步到扩展，正在回到微光翻译。'],
  verified: ['邮箱已验证', '回到微光翻译的面板，用邮箱和密码登录即可。可以关闭此页面了。'],
};

Deno.serve((req) => {
  const status = new URL(req.url).searchParams.get('status') || 'success';
  const [title, text] = PAGES[status] || PAGES.success;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · 微光翻译</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#161617;color:#f2f2f3;
    font:16px/1.6 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif}
  .card{max-width:420px;margin:24px;padding:36px 32px;border-radius:18px;background:#1f1f21;text-align:center}
  .icon{width:56px;height:56px;margin:0 auto 16px;border-radius:16px;display:grid;place-items:center;
    font-size:28px;background:linear-gradient(135deg,#9b7bff,#5b4cf0)}
  h1{margin:0 0 8px;font-size:22px} p{margin:0;color:#a1a1a6}
</style></head><body><div class="card"><div class="icon">${status === 'cancel' ? '↩' : '✓'}</div>
<h1>${title}</h1><p>${text}</p></div>
<script>if (location.hash) history.replaceState(null, '', location.pathname + location.search)</script></body></html>`; // 验证链接会在 # 后附带令牌，不留在地址栏
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
});
