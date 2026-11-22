// 注册前检查邮箱所在的域名能不能收信（有没有 MX 记录）。
// 云端 Supabase 不会拒绝填错的域名（如 a@panda.com，panda.com 没有邮件服务器）：照样“发出”验证邮件，
// 用户一直等一封永远不会到的邮件。插件注册前先调用这里，只传域名，不传完整邮箱。
// POST { domain } → { deliverable: true | false | null }（null 表示查不出来，插件放行）。无需登录
import { corsHeaders, json } from '../_shared/http.ts';
import { domainDeliverable } from '../_shared/email.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: '仅支持 POST' }, 405);
  const { domain = '' } = await req.json().catch(() => ({}));
  // 本地 Supabase 里 SUPABASE_URL 是容器内地址（如 http://kong:8000），云端是 https://<项目>.supabase.co
  const local = !/\.supabase\.co/.test(Deno.env.get('SUPABASE_URL') || '');
  return json({ deliverable: await domainDeliverable(String(domain), (d) => Deno.resolveDns(d, 'MX'), { local }) });
});
