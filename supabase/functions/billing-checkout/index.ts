// 创建 Stripe Checkout 订阅支付页，返回跳转地址
// POST { plan: 'premium' | 'premium_plus', interval: 'month' | 'year' }，需要登录（Authorization: Bearer <access_token>）
// Premium 只有年付；Premium+ 有月付与年付。已是会员时返回 code=use_portal，由客户端打开客户门户升级 / 切换方案。
import { corsHeaders, json, publicUrl } from '../_shared/http.ts';
import { adminClient, prices, stripeClient, userFromRequest } from '../_shared/clients.ts';

export function priceFor(plan: string, interval: string, p = prices()): string | null {
  if (plan === 'premium') return p.premiumYearly || null; // 仅年付
  if (plan === 'premium_plus') return (interval === 'month' ? p.plusMonthly : p.plusYearly) || null;
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: '仅支持 POST' }, 405);

  try {
    const user = await userFromRequest(req);
    if (!user) return json({ error: '请先登录' }, 401);

    const { plan = 'premium_plus', interval = 'year' } = await req.json().catch(() => ({}));
    const price = priceFor(plan, interval);
    if (!price) return json({ error: '该方案尚未配置价格（缺少 STRIPE_PRICE_* 环境变量）' }, 500);

    const db = adminClient();
    const stripe = stripeClient();
    const { data: profile, error } = await db
      .from('profiles')
      .select('plan, stripe_customer_id')
      .eq('id', user.id)
      .single();
    if (error) throw error;
    if (profile.plan !== 'free') {
      return json({ error: '你已经是会员，请在“管理订阅”中升级或切换方案', code: 'use_portal' }, 409);
    }

    // 每个用户对应一个 Stripe customer，首次订阅时创建
    let customer = profile.stripe_customer_id as string | null;
    if (!customer) {
      const c = await stripe.customers.create({ email: user.email, metadata: { user_id: user.id } });
      customer = c.id;
      const { error: e2 } = await db.from('profiles').update({ stripe_customer_id: customer }).eq('id', user.id);
      if (e2) throw e2;
    }

    const returnUrl = `${publicUrl()}/functions/v1/billing-return`;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer,
      client_reference_id: user.id,
      line_items: [{ price, quantity: 1 }],
      subscription_data: { metadata: { user_id: user.id, plan } },
      allow_promotion_codes: true,
      success_url: `${returnUrl}?status=success`,
      cancel_url: `${returnUrl}?status=cancel`,
    });
    return json({ url: session.url });
  } catch (e) {
    console.error('billing-checkout', e);
    return json({ error: (e as Error).message || '创建支付失败' }, 500);
  }
});
