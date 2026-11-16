// 创建 Stripe Checkout 订阅支付页，返回跳转地址
// POST { interval: 'month' | 'year' }，需要登录（Authorization: Bearer <access_token>）
import { corsHeaders, env, json } from '../_shared/http.ts';
import { adminClient, stripeClient, userFromRequest } from '../_shared/clients.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: '仅支持 POST' }, 405);

  try {
    const user = await userFromRequest(req);
    if (!user) return json({ error: '请先登录' }, 401);

    const { interval = 'month' } = await req.json().catch(() => ({}));
    const price = interval === 'year' ? env('STRIPE_PRICE_YEARLY') : env('STRIPE_PRICE_MONTHLY');

    const db = adminClient();
    const stripe = stripeClient();
    const { data: profile, error } = await db
      .from('profiles')
      .select('plan, stripe_customer_id')
      .eq('id', user.id)
      .single();
    if (error) throw error;
    if (profile.plan === 'pro') return json({ error: '你已经是 Pro 会员，可在“管理订阅”中修改方案' }, 409);

    // 每个用户对应一个 Stripe customer，首次订阅时创建
    let customer = profile.stripe_customer_id as string | null;
    if (!customer) {
      const c = await stripe.customers.create({ email: user.email, metadata: { user_id: user.id } });
      customer = c.id;
      const { error: e2 } = await db.from('profiles').update({ stripe_customer_id: customer }).eq('id', user.id);
      if (e2) throw e2;
    }

    const returnUrl = `${env('SUPABASE_URL')}/functions/v1/billing-return`;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer,
      client_reference_id: user.id,
      line_items: [{ price, quantity: 1 }],
      subscription_data: { metadata: { user_id: user.id } },
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
