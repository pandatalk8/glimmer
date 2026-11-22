// 支付完成 / 取消 / 退出订阅管理后的返回页，以及邮箱验证后的落地页（auth.site_url 指向 ?status=verified）。
// 扩展检测到此地址后会接管标签页：支付结果回到发起页面，邮箱验证换成扩展内的结果页（welcome/verified.html）。
//
// 返回纯文本而不是网页：云端 Supabase 为防钓鱼，会把 supabase.co 上 GET 请求返回的 HTML 改成
// text/plain 并加 sandbox，网页会显示成源代码，且丢掉 charset 导致中文乱码。纯文本 + 显式 UTF-8
// 在扩展没来得及接管（或用户没装扩展）时也能看懂。
const PAGES: Record<string, [string, string]> = {
  success: ['支付成功', '感谢支持！正在确认会员状态，几秒后自动回到微光翻译。'],
  cancel: ['已取消支付', '没有产生任何费用，正在回到微光翻译。'],
  portal: ['订阅设置已保存', '修改会在几秒内同步到扩展，正在回到微光翻译。'],
  verified: ['邮箱验证', '请回到微光翻译的面板，用邮箱和密码登录。如果提示邮箱尚未验证，请重新注册以获取新的验证邮件。可以关闭此页面了。'],
};

Deno.serve((req) => {
  const status = new URL(req.url).searchParams.get('status') || 'success';
  const [title, text] = PAGES[status] || PAGES.success;
  return new Response(`${title} · 微光翻译\n\n${text}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
});
