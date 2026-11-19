// 订阅同步的核心逻辑：把 Stripe 事件转换成数据库更新。
// 不直接依赖 Stripe SDK 和 Supabase 客户端，通过 deps 注入，便于单元测试。

export type Plan = 'free' | 'premium' | 'premium_plus';
export type PaidPlan = Exclude<Plan, 'free'>;

export interface StripeSubscriptionLike {
  id: string;
  customer: string | { id: string };
  status: string;
  cancel_at_period_end?: boolean;
  current_period_end?: number | null;
  metadata?: Record<string, string>;
  items?: {
    data: Array<{
      current_period_end?: number | null;
      price?: { id: string; recurring?: { interval?: string } | null } | null;
    }>;
  };
}

export interface StripeEventLike {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export interface ProfilePatch {
  plan?: Plan;
  stripe_customer_id?: string;
  subscription_status?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
}

export interface SubscriptionRow {
  id: string;
  user_id: string;
  status: string;
  price_id: string | null;
  billing_interval: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

export interface BillingDeps {
  /** 记录事件；已处理过返回 false */
  recordEvent(id: string, type: string): Promise<boolean>;
  findUserIdByCustomer(customerId: string): Promise<string | null>;
  updateProfile(userId: string, patch: ProfilePatch): Promise<void>;
  upsertSubscription(row: SubscriptionRow): Promise<void>;
  retrieveSubscription(id: string): Promise<StripeSubscriptionLike>;
  /** 价格 ID 对应的会员等级（Premium 年付 → premium；Premium+ 月付 / 年付 → premium_plus） */
  planForPrice(priceId: string | null): PaidPlan;
}

// 这些状态视为有效订阅
const ACTIVE = new Set(['active', 'trialing']);
// past_due 时给用户宽限期，仍保留会员，直到 Stripe 最终取消
const GRACE = new Set(['past_due']);

/** 订阅是否让用户保有会员资格 */
export function isEntitled(status: string | null | undefined): boolean {
  return !!status && (ACTIVE.has(status) || GRACE.has(status));
}

/** 订阅状态 + 价格 → 会员等级 */
export function planFor(status: string | null | undefined, priceId: string | null, planForPrice: (p: string | null) => PaidPlan): Plan {
  return isEntitled(status) ? planForPrice(priceId) : 'free';
}

/** 由环境变量构建“价格 → 等级”映射；未知价格（如旧版 Pro 价格）按 premium_plus 处理，不让老用户降级 */
export function priceMap(env: { premiumYearly?: string; plusMonthly?: string; plusYearly?: string }) {
  return (priceId: string | null): PaidPlan => {
    if (priceId && priceId === env.premiumYearly) return 'premium';
    return 'premium_plus';
  };
}

const toIso = (sec: number | null | undefined) => (sec ? new Date(sec * 1000).toISOString() : null);
const customerId = (c: StripeSubscriptionLike['customer']) => (typeof c === 'string' ? c : c?.id);

// Stripe 新版 API 把 current_period_end 移到了订阅项上，两处都兼容
export function periodEnd(sub: StripeSubscriptionLike): number | null {
  return sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;
}

export async function syncSubscription(sub: StripeSubscriptionLike, deps: BillingDeps, hintUserId?: string) {
  const cust = customerId(sub.customer);
  const userId = hintUserId || sub.metadata?.user_id || (cust ? await deps.findUserIdByCustomer(cust) : null);
  if (!userId) throw new Error(`找不到订阅 ${sub.id} 对应的用户（customer=${cust}）`);

  const item = sub.items?.data?.[0];
  const end = toIso(periodEnd(sub));
  await deps.upsertSubscription({
    id: sub.id,
    user_id: userId,
    status: sub.status,
    price_id: item?.price?.id ?? null,
    billing_interval: item?.price?.recurring?.interval ?? null,
    current_period_end: end,
    cancel_at_period_end: !!sub.cancel_at_period_end,
  });
  await deps.updateProfile(userId, {
    plan: planFor(sub.status, item?.price?.id ?? null, deps.planForPrice),
    stripe_customer_id: cust,
    subscription_status: sub.status,
    current_period_end: end,
    cancel_at_period_end: !!sub.cancel_at_period_end,
  });
  return userId;
}

export const HANDLED_EVENTS = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

/** 处理一个已验证签名的 Stripe 事件，返回处理结果描述 */
export async function handleEvent(event: StripeEventLike, deps: BillingDeps): Promise<string> {
  if (!HANDLED_EVENTS.has(event.type)) return 'ignored';
  if (!(await deps.recordEvent(event.id, event.type))) return 'duplicate';

  const obj = event.data.object;
  if (event.type === 'checkout.session.completed') {
    if (obj.mode !== 'subscription' || !obj.subscription) return 'ignored';
    const subId = typeof obj.subscription === 'string' ? obj.subscription : (obj.subscription as { id: string }).id;
    const sub = await deps.retrieveSubscription(subId);
    const userId = await syncSubscription(sub, deps, (obj.client_reference_id as string) || undefined);
    return `synced ${userId}`;
  }
  const userId = await syncSubscription(obj as unknown as StripeSubscriptionLike, deps);
  return `synced ${userId}`;
}
