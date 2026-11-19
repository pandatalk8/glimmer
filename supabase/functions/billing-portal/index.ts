// 打开 Stripe 客户门户：修改方案、更换支付方式、取消订阅、查看发票
// POST，需要登录
import { corsHeaders, json, publicUrl } from '../_shared/http.ts';
import { adminClient, stripeClient, userFromRequest } from '../_shared/clients.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: '仅支持 POST' }, 405);

  try {
    const user = await userFromRequest(req);
    if (!user) return json({ error: '请先登录' }, 401);

    const { data: profile, error } = await adminClient()
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .single();
    if (error) throw error;
    if (!profile.stripe_customer_id) return json({ error: '还没有订阅记录' }, 404);

    // 可选：用接口创建的门户配置（bpc_…）；不设置时使用 Stripe 后台保存的默认配置
    const configuration = Deno.env.get('STRIPE_PORTAL_CONFIGURATION') || undefined;
    const session = await stripeClient().billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${publicUrl()}/functions/v1/billing-return?status=portal`,
      ...(configuration ? { configuration } : {}),
    });
    return json({ url: session.url });
  } catch (e) {
    console.error('billing-portal', e);
    return json({ error: (e as Error).message || '打开订阅管理失败' }, 500);
  }
});
