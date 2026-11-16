// Stripe webhook：验证签名后同步订阅状态到数据库
// 在 Stripe 后台配置此地址，订阅事件：checkout.session.completed、customer.subscription.created/updated/deleted
import Stripe from 'npm:stripe@17.7.0';
import { env, json } from '../_shared/http.ts';
import { adminClient, billingDeps, stripeClient } from '../_shared/clients.ts';
import { handleEvent, type StripeEventLike } from '../_shared/billing.ts';

const cryptoProvider = Stripe.createSubtleCryptoProvider();

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: '仅支持 POST' }, 405);
  const signature = req.headers.get('Stripe-Signature');
  if (!signature) return json({ error: '缺少 Stripe-Signature' }, 400);

  const body = await req.text();
  const stripe = stripeClient();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, env('STRIPE_WEBHOOK_SECRET'), undefined, cryptoProvider);
  } catch (e) {
    console.error('签名验证失败', (e as Error).message);
    return json({ error: '签名无效' }, 400);
  }

  try {
    const result = await handleEvent(event as unknown as StripeEventLike, billingDeps(adminClient(), stripe));
    console.log(event.type, event.id, result);
    return json({ received: true, result });
  } catch (e) {
    // 返回 500 让 Stripe 稍后重试
    console.error('处理事件失败', event.type, event.id, e);
    return json({ error: (e as Error).message }, 500);
  }
});
