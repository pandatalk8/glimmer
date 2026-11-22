// Stripe 与 Supabase 客户端，以及 BillingDeps 的真实实现
import Stripe from 'npm:stripe@17.7.0';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.49.4';
import { env } from './http.ts';
import { priceMap, type BillingDeps, type StripeSubscriptionLike, type SubscriptionRow } from './billing.ts';

/** 三个价格 ID（Stripe 后台或 scripts/setup_stripe.py 创建） */
export function prices() {
  return {
    premiumYearly: Deno.env.get('STRIPE_PRICE_PREMIUM_YEARLY') || '',
    plusMonthly: Deno.env.get('STRIPE_PRICE_PLUS_MONTHLY') || '',
    plusYearly: Deno.env.get('STRIPE_PRICE_PLUS_YEARLY') || '',
  };
}

export function stripeClient() {
  return new Stripe(env('STRIPE_SECRET_KEY'), {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

// service role：绕过 RLS，只在服务端使用
export function adminClient(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** 从请求的 Authorization 头解析当前登录用户；无效时返回 null */
export async function userFromRequest(req: Request) {
  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data, error } = await adminClient().auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

export function billingDeps(db: SupabaseClient, stripe: Stripe): BillingDeps {
  const now = () => new Date().toISOString();
  return {
    planForPrice: priceMap(prices()),
    async recordEvent(id, type) {
      const { error } = await db.from('stripe_events').insert({ id, type });
      if (error?.code === '23505') return false; // 唯一键冲突：已处理过
      if (error) throw error;
      return true;
    },
    async findUserIdByCustomer(customerId) {
      const { data, error } = await db.from('profiles').select('id').eq('stripe_customer_id', customerId).maybeSingle();
      if (error) throw error;
      return data?.id ?? null;
    },
    async updateProfile(userId, patch) {
      const { error } = await db.from('profiles').update({ ...patch, updated_at: now() }).eq('id', userId);
      if (error) throw error;
    },
    async upsertSubscription(row) {
      const { error } = await db.from('subscriptions').upsert({ ...row, updated_at: now() });
      if (error) throw error;
    },
    async listSubscriptions(userId) {
      const { data, error } = await db
        .from('subscriptions')
        .select('id,user_id,status,price_id,billing_interval,current_period_end,cancel_at_period_end')
        .eq('user_id', userId);
      if (error) throw error;
      return (data || []) as SubscriptionRow[];
    },
    async retrieveSubscription(id) {
      return (await stripe.subscriptions.retrieve(id)) as unknown as StripeSubscriptionLike;
    },
  };
}
