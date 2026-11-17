// 账户与订阅：直接调用 Supabase 的 REST 接口（Auth / PostgREST / Edge Functions），不依赖 SDK
// 会话保存在 chrome.storage.local 的 auth；供界面显示的账户状态保存在 account
import { BACKEND } from '../shared/config.js';

const AUTH_KEY = 'auth';
const ACCOUNT_KEY = 'account';

// 开发 / 测试时可在 storage.local 的 backendOverride 中覆盖地址
async function backend() {
  const { backendOverride } = await chrome.storage.local.get('backendOverride');
  const cfg = { ...BACKEND, ...(backendOverride || {}) };
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    const e = new Error('账户服务尚未配置（需要在 src/shared/config.js 填写 Supabase 地址）');
    e.code = 'not_configured';
    throw e;
  }
  return { url: cfg.supabaseUrl.replace(/\/$/, ''), key: cfg.supabaseAnonKey };
}

export async function isConfigured() {
  try {
    await backend();
    return true;
  } catch {
    return false;
  }
}

// Supabase 的英文报错转为中文
const MESSAGES = [
  [/invalid login credentials/i, '邮箱或密码错误'],
  [/email not confirmed/i, '邮箱尚未验证，请先点击验证邮件中的链接'],
  [/user already registered|already been registered/i, '该邮箱已注册，请直接登录'],
  [/password should be at least/i, '密码至少需要 6 位'],
  [/unable to validate email|invalid email|email address .* is invalid/i, '邮箱格式不正确'],
  [/rate limit|too many requests/i, '操作太频繁，请稍后再试'],
  [/signups not allowed/i, '暂未开放注册'],
];

function friendly(msg, status) {
  for (const [re, zh] of MESSAGES) if (re.test(msg)) return zh;
  if (status === 401) return '登录已过期，请重新登录';
  return msg || `请求失败（${status}）`;
}

async function call(path, { method = 'GET', body, token, headers = {} } = {}) {
  const { url, key } = await backend();
  let res;
  try {
    res = await fetch(url + path, {
      method,
      headers: {
        apikey: key,
        'Content-Type': 'application/json',
        // 只在登录后携带用户令牌；新版 publishable key（sb_publishable_…）不是 JWT，不能放进 Authorization
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new Error(e?.name === 'TimeoutError' ? '连接账户服务超时' : '无法连接账户服务，请检查网络');
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const msg = data?.error_description || data?.msg || data?.message || data?.error || text;
    const err = new Error(friendly(String(msg || ''), res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- 会话 ----------
async function saveSession(s) {
  const auth = {
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600),
    user: { id: s.user?.id, email: s.user?.email },
  };
  await chrome.storage.local.set({ [AUTH_KEY]: auth });
  return auth;
}

async function getAuth() {
  return (await chrome.storage.local.get(AUTH_KEY))[AUTH_KEY] || null;
}

async function clearSession() {
  await chrome.storage.local.remove([AUTH_KEY]);
  await chrome.storage.local.set({ [ACCOUNT_KEY]: null });
}

let refreshing = null;
/** 返回有效的 access token，临近过期时自动刷新；未登录返回 null */
export async function getToken() {
  const auth = await getAuth();
  if (!auth) return null;
  if (auth.expires_at - 60 > Date.now() / 1000) return auth.access_token;
  refreshing ||= (async () => {
    try {
      const s = await call('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        body: { refresh_token: auth.refresh_token },
      });
      return (await saveSession(s)).access_token;
    } catch (e) {
      if (e.status && e.status < 500) await clearSession(); // refresh token 失效：退出登录
      throw e;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// ---------- 账户操作 ----------
export async function signUp({ email, password }) {
  const s = await call('/auth/v1/signup', { method: 'POST', body: { email, password } });
  // 开启邮箱验证时，注册成功但没有会话
  if (!s?.access_token) return { needConfirm: true, email };
  await saveSession(s);
  return { needConfirm: false, account: await refreshAccount() };
}

export async function signIn({ email, password }) {
  const s = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
  await saveSession(s);
  return { account: await refreshAccount() };
}

export async function signOut() {
  const auth = await getAuth();
  if (auth) await call('/auth/v1/logout', { method: 'POST', token: auth.access_token }).catch(() => {});
  await clearSession();
  return true;
}

export async function resetPassword({ email }) {
  await call('/auth/v1/recover', { method: 'POST', body: { email } });
  return true;
}

/** 从数据库读取套餐状态，写入 storage 供界面显示 */
export async function refreshAccount() {
  const token = await getToken();
  if (!token) {
    await chrome.storage.local.set({ [ACCOUNT_KEY]: null });
    return null;
  }
  const auth = await getAuth();
  const rows = await call(
    `/rest/v1/profiles?id=eq.${auth.user.id}&select=email,plan,subscription_status,current_period_end,cancel_at_period_end,stripe_customer_id`,
    { token }
  );
  const p = rows?.[0] || {};
  const account = {
    email: p.email || auth.user.email,
    plan: p.plan === 'pro' ? 'pro' : 'free',
    status: p.subscription_status || null,
    periodEnd: p.current_period_end || null,
    cancelAtPeriodEnd: !!p.cancel_at_period_end,
    hasBilling: !!p.stripe_customer_id,
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({ [ACCOUNT_KEY]: account });
  return account;
}

export async function accountState() {
  const configured = await isConfigured();
  const auth = await getAuth();
  const { account } = await chrome.storage.local.get(ACCOUNT_KEY);
  return { configured, loggedIn: !!auth, email: auth?.user?.email || null, account: account || null };
}

/** 是否为 Pro 会员（供以后需要付费的功能判断） */
export async function isPro() {
  const { account } = await chrome.storage.local.get(ACCOUNT_KEY);
  return account?.plan === 'pro';
}

async function openBilling(fn, body) {
  const token = await getToken();
  if (!token) throw new Error('请先登录');
  const { url } = await call(`/functions/v1/${fn}`, { method: 'POST', token, body });
  await chrome.tabs.create({ url });
  return true;
}

export const checkout = ({ interval }) => openBilling('billing-checkout', { interval: interval === 'year' ? 'year' : 'month' });
export const openPortal = () => openBilling('billing-portal', {});

// 支付 / 管理订阅返回页打开时，webhook 可能稍晚到达，间隔刷新几次
export function watchBillingReturn() {
  chrome.tabs.onUpdated.addListener(async (_id, info, tab) => {
    if (info.status !== 'complete' || !tab.url) return;
    let base;
    try {
      base = (await backend()).url;
    } catch {
      return;
    }
    if (!tab.url.startsWith(`${base}/functions/v1/billing-return`)) return;
    for (const wait of [0, 2000, 5000, 10000]) {
      await new Promise((r) => setTimeout(r, wait));
      const a = await refreshAccount().catch(() => null);
      if (a?.plan === 'pro' && tab.url.includes('status=success')) break;
    }
  });
}
