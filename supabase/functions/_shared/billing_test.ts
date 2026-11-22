// 运行：deno test supabase/functions/
import { assertEquals, assertRejects } from 'jsr:@std/assert@1.0.13';
import Stripe from 'npm:stripe@17.7.0';
import { type BillingDeps, handleEvent, planFor, priceMap, periodEnd, type StripeSubscriptionLike, type SubscriptionRow } from './billing.ts';

const PRICES = { premiumYearly: 'price_premium_year', plusMonthly: 'price_plus_month', plusYearly: 'price_plus_year' };

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
    listSubscriptions: async (uid) => [...subscriptions.values()].filter((r) => r.user_id === uid) as unknown as SubscriptionRow[],
    planForPrice: priceMap(PRICES),
  };
  return { deps, profiles, subscriptions, events };
}

const sub = (over: Partial<StripeSubscriptionLike> = {}): StripeSubscriptionLike => ({
  id: 'sub_1',
  customer: 'cus_1',
  status: 'active',
  cancel_at_period_end: false,
  items: { data: [{ current_period_end: 1798761600, price: { id: 'price_plus_month', recurring: { interval: 'month' } } }] },
  ...over,
});

Deno.test('订阅状态 + 价格映射为会员等级', () => {
  const map = priceMap(PRICES);
  assertEquals(planFor('active', 'price_premium_year', map), 'premium');
  assertEquals(planFor('active', 'price_plus_month', map), 'premium_plus');
  assertEquals(planFor('active', 'price_plus_year', map), 'premium_plus');
  assertEquals(planFor('trialing', 'price_premium_year', map), 'premium');
  assertEquals(planFor('past_due', 'price_plus_year', map), 'premium_plus'); // 宽限期
  assertEquals(planFor('active', 'price_old_pro', map), 'premium_plus'); // 旧版 Pro 价格不降级
  assertEquals(planFor('canceled', 'price_plus_year', map), 'free');
  assertEquals(planFor('incomplete', 'price_premium_year', map), 'free');
  assertEquals(planFor(undefined, null, map), 'free');
});

Deno.test('兼容新旧 API 的 current_period_end 位置', () => {
  assertEquals(periodEnd(sub()), 1798761600);
  assertEquals(periodEnd(sub({ current_period_end: 1700000000 })), 1700000000);
});

Deno.test('支付完成：开通 Premium+，写入订阅', async () => {
  const { deps, profiles, subscriptions } = fakeDeps({ sub_1: sub() });
  const r = await handleEvent(
    { id: 'evt_1', type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_1', client_reference_id: 'user-1' } } },
    deps
  );
  assertEquals(r, 'synced user-1');
  const p = profiles.get('user-1')!;
  assertEquals(p.plan, 'premium_plus');
  assertEquals(p.subscription_status, 'active');
  assertEquals(p.current_period_end, '2027-01-01T00:00:00.000Z');
  assertEquals(subscriptions.get('sub_1')!.billing_interval, 'month');
});

Deno.test('Premium 年付：等级为 premium', async () => {
  const { deps, profiles } = fakeDeps();
  const premium = sub({ items: { data: [{ current_period_end: 1798761600, price: { id: 'price_premium_year', recurring: { interval: 'year' } } }] } });
  await handleEvent({ id: 'evt_p', type: 'customer.subscription.created', data: { object: { ...premium } } }, deps);
  assertEquals(profiles.get('user-1')!.plan, 'premium');
});

Deno.test('设置到期取消：仍为会员，标记 cancel_at_period_end', async () => {
  const { deps, profiles } = fakeDeps();
  await handleEvent({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: { ...sub({ cancel_at_period_end: true }) } } }, deps);
  assertEquals(profiles.get('user-1')!.plan, 'premium_plus');
  assertEquals(profiles.get('user-1')!.cancel_at_period_end, true);
});

Deno.test('订阅删除：降为免费版（按 customer 找到用户）', async () => {
  const { deps, profiles } = fakeDeps();
  await handleEvent({ id: 'evt_3', type: 'customer.subscription.deleted', data: { object: { ...sub({ status: 'canceled' }) } } }, deps);
  assertEquals(profiles.get('user-1')!.plan, 'free');
  assertEquals(profiles.get('user-1')!.subscription_status, 'canceled');
});

Deno.test('事件乱序：迟到的 created（快照仍是 incomplete）不会把刚开通的会员降级', async () => {
  const premium = { current_period_end: 1798761600, price: { id: 'price_premium_year', recurring: { interval: 'year' } } };
  const active = sub({ items: { data: [premium] } });
  const { deps, profiles } = fakeDeps({ sub_1: active }); // Stripe 上的最新状态：active
  await handleEvent({ id: 'evt_u', type: 'customer.subscription.updated', data: { object: { ...active } } }, deps);
  await handleEvent({ id: 'evt_c', type: 'customer.subscription.created', data: { object: { ...sub({ status: 'incomplete', items: { data: [premium] } }) } } }, deps);
  assertEquals(profiles.get('user-1')!.plan, 'premium');
  assertEquals(profiles.get('user-1')!.subscription_status, 'active');
});

Deno.test('同一客户多条订阅：被拒卡留下的订阅过期，不影响另一条有效订阅', async () => {
  const premium = { current_period_end: 1798761600, price: { id: 'price_premium_year', recurring: { interval: 'year' } } };
  const { deps, profiles } = fakeDeps();
  await handleEvent({ id: 'evt_a', type: 'customer.subscription.created', data: { object: { ...sub({ id: 'sub_declined', status: 'incomplete', items: { data: [premium] } }) } } }, deps);
  await handleEvent({ id: 'evt_b', type: 'customer.subscription.updated', data: { object: { ...sub({ id: 'sub_ok', items: { data: [premium] } }) } } }, deps);
  assertEquals(profiles.get('user-1')!.plan, 'premium');
  await handleEvent({ id: 'evt_x', type: 'customer.subscription.updated', data: { object: { ...sub({ id: 'sub_declined', status: 'incomplete_expired', items: { data: [premium] } }) } } }, deps);
  assertEquals(profiles.get('user-1')!.plan, 'premium');
  assertEquals(profiles.get('user-1')!.subscription_status, 'active');
  // 有效的那条被取消后才降为免费版
  await handleEvent({ id: 'evt_y', type: 'customer.subscription.deleted', data: { object: { ...sub({ id: 'sub_ok', status: 'canceled', items: { data: [premium] } }) } } }, deps);
  assertEquals(profiles.get('user-1')!.plan, 'free');
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
