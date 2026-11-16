// 运行：deno test supabase/functions/
import { assertEquals, assertRejects } from 'jsr:@std/assert@1.0.13';
import Stripe from 'npm:stripe@17.7.0';
import { type BillingDeps, handleEvent, planFromStatus, periodEnd, type StripeSubscriptionLike } from './billing.ts';

// 内存版数据库
function fakeDeps(subs: Record<string, StripeSubscriptionLike> = {}) {
  const profiles = new Map<string, Record<string, unknown>>([['user-1', { plan: 'free', stripe_customer_id: 'cus_1' }]]);
  const subscriptions = new Map<string, Record<string, unknown>>();
  const events = new Set<string>();
  const deps: BillingDeps = {
    recordEvent: async (id) => (events.has(id) ? false : (events.add(id), true)),
    findUserIdByCustomer: async (c) => [...profiles].find(([, p]) => p.stripe_customer_id === c)?.[0] ?? null,
    updateProfile: async (id, patch) => void profiles.set(id, { ...profiles.get(id), ...patch }),
    upsertSubscription: async (row) => void subscriptions.set(row.id, { ...row }),
    retrieveSubscription: async (id) => subs[id],
  };
  return { deps, profiles, subscriptions, events };
}

const sub = (over: Partial<StripeSubscriptionLike> = {}): StripeSubscriptionLike => ({
  id: 'sub_1',
  customer: 'cus_1',
  status: 'active',
  cancel_at_period_end: false,
  items: { data: [{ current_period_end: 1798761600, price: { id: 'price_month', recurring: { interval: 'month' } } }] },
  ...over,
});

Deno.test('订阅状态映射为套餐', () => {
  assertEquals(planFromStatus('active'), 'pro');
  assertEquals(planFromStatus('trialing'), 'pro');
  assertEquals(planFromStatus('past_due'), 'pro'); // 宽限期
  assertEquals(planFromStatus('canceled'), 'free');
  assertEquals(planFromStatus('incomplete'), 'free');
  assertEquals(planFromStatus(undefined), 'free');
});

Deno.test('兼容新旧 API 的 current_period_end 位置', () => {
  assertEquals(periodEnd(sub()), 1798761600);
  assertEquals(periodEnd(sub({ current_period_end: 1700000000 })), 1700000000);
});

Deno.test('支付完成：开通 Pro，写入订阅', async () => {
  const { deps, profiles, subscriptions } = fakeDeps({ sub_1: sub() });
  const r = await handleEvent(
    { id: 'evt_1', type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_1', client_reference_id: 'user-1' } } },
    deps
  );
  assertEquals(r, 'synced user-1');
  const p = profiles.get('user-1')!;
  assertEquals(p.plan, 'pro');
  assertEquals(p.subscription_status, 'active');
  assertEquals(p.current_period_end, '2027-01-01T00:00:00.000Z');
  assertEquals(subscriptions.get('sub_1')!.billing_interval, 'month');
});

Deno.test('设置到期取消：仍为 Pro，标记 cancel_at_period_end', async () => {
  const { deps, profiles } = fakeDeps();
  await handleEvent({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: { ...sub({ cancel_at_period_end: true }) } } }, deps);
  assertEquals(profiles.get('user-1')!.plan, 'pro');
  assertEquals(profiles.get('user-1')!.cancel_at_period_end, true);
});

Deno.test('订阅删除：降为免费版（按 customer 找到用户）', async () => {
  const { deps, profiles } = fakeDeps();
  await handleEvent({ id: 'evt_3', type: 'customer.subscription.deleted', data: { object: { ...sub({ status: 'canceled' }) } } }, deps);
  assertEquals(profiles.get('user-1')!.plan, 'free');
  assertEquals(profiles.get('user-1')!.subscription_status, 'canceled');
});

Deno.test('重复投递的事件只处理一次', async () => {
  const { deps } = fakeDeps();
  const e = { id: 'evt_4', type: 'customer.subscription.updated', data: { object: { ...sub() } } };
  assertEquals(await handleEvent(e, deps), 'synced user-1');
  assertEquals(await handleEvent(e, deps), 'duplicate');
});

Deno.test('无关事件与一次性付款被忽略', async () => {
  const { deps } = fakeDeps();
  assertEquals(await handleEvent({ id: 'evt_5', type: 'invoice.paid', data: { object: {} } }, deps), 'ignored');
  assertEquals(
    await handleEvent({ id: 'evt_6', type: 'checkout.session.completed', data: { object: { mode: 'payment' } } }, deps),
    'ignored'
  );
});

Deno.test('找不到用户时报错，让 Stripe 重试', async () => {
  const { deps } = fakeDeps();
  await assertRejects(
    () => handleEvent({ id: 'evt_7', type: 'customer.subscription.updated', data: { object: { ...sub({ customer: 'cus_unknown' }) } } }, deps),
    Error,
    '找不到订阅'
  );
});

Deno.test('Stripe 签名：正确签名通过，篡改后拒绝', async () => {
  const stripe = new Stripe('sk_test_dummy', { httpClient: Stripe.createFetchHttpClient() });
  const crypto = Stripe.createSubtleCryptoProvider();
  const secret = 'whsec_test_secret';
  const payload = JSON.stringify({ id: 'evt_sig', object: 'event', type: 'customer.subscription.updated', data: { object: {} } });
  const header = await stripe.webhooks.generateTestHeaderStringAsync({ payload, secret, cryptoProvider: crypto });
  const ev = await stripe.webhooks.constructEventAsync(payload, header, secret, undefined, crypto);
  assertEquals(ev.id, 'evt_sig');
  await assertRejects(() => stripe.webhooks.constructEventAsync(payload.replace('evt_sig', 'evt_bad'), header, secret, undefined, crypto));
});
