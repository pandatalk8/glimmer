// 账户与订阅：直接调用 Supabase 的 REST 接口（Auth / PostgREST / Edge Functions），不依赖 SDK
// 会话保存在 chrome.storage.local 的 auth；供界面显示的账户状态保存在 account
import { BACKEND, LOCAL_DEV_BACKEND } from '../shared/config.js';
import { PLAN_NAME, PLAN_RANK } from '../shared/settings.js';

const AUTH_KEY = 'auth';
const ACCOUNT_KEY = 'account';

let devInstall;
/** 是否以“加载已解压的扩展程序”方式加载（开发版） */
async function isDevInstall() {
  if (devInstall === undefined) {
    try {
      devInstall = (await chrome.management.getSelf()).installType === 'development';
    } catch {
      devInstall = false;
    }
  }
  return devInstall;
}

const filled = (c) => !!(c?.supabaseUrl && c?.supabaseAnonKey);

/**
 * 决定连接哪个后端，优先级：
 * 1. storage.local 的 backendOverride（测试或手动指定；整体替换，填空值可模拟“未配置”）
 * 2. config.js 的 BACKEND（正式发布时填写的云端地址）
 * 3. 开发版且以上都没有：自动连接本机 Supabase（LOCAL_DEV_BACKEND）
 */
async function resolveBackend() {
  const { backendOverride } = await chrome.storage.local.get('backendOverride');
  if (backendOverride) return { cfg: backendOverride, source: 'override' };
  if (filled(BACKEND)) return { cfg: BACKEND, source: 'config' };
  if (await isDevInstall()) return { cfg: LOCAL_DEV_BACKEND, source: 'local-dev' };
  return { cfg: BACKEND, source: 'none' };
}

async function backend() {
  const { cfg, source } = await resolveBackend();
  if (!filled(cfg)) {
    const e = new Error('账户服务尚未配置（需要在 src/shared/config.js 填写 Supabase 地址）');
    e.code = 'not_configured';
    throw e;
  }
  const url = cfg.supabaseUrl.replace(/\/$/, '');
  return { url, key: cfg.supabaseAnonKey, source, local: /\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url) };
}

/** 供界面显示：当前连接的后端 */
export async function backendInfo() {
  try {
    const { url, source, local } = await backend();
    return { url, source, local };
  } catch {
    return null;
  }
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
  const { url, key, local } = await backend();
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
    if (local) throw new Error('本地后端没有运行：请打开 Docker Desktop，并在项目目录执行 npx supabase start');
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
    err.code = data?.code; // 后端返回的错误类型：login / upgrade / quota …
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

/**
 * 第三方登录（目前只有 Google）：Supabase 的 OAuth 授权页 → 用户在 Google 授权 →
 * 跳回 https://<扩展ID>.chromiumapp.org/supabase，地址中带有访问令牌与刷新令牌。
 * 需要在 Supabase 中开启对应登录方式，并把上面的跳回地址加入允许的回调地址。
 */
export async function signInWithOAuth({ provider }) {
  const { url } = await backend();
  const settings = await call('/auth/v1/settings').catch(() => null);
  if (settings && !settings.external?.[provider]) {
    throw new Error(provider === 'google' ? '尚未开启 Google 登录：需要先在 Supabase 中配置 Google OAuth（见后端部署指南）' : '该登录方式尚未开启');
  }
  const redirect = chrome.identity.getRedirectURL('supabase');
  const authUrl = `${url}/auth/v1/authorize?provider=${encodeURIComponent(provider)}&redirect_to=${encodeURIComponent(redirect)}`;
  let result;
  try {
    result = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  } catch (e) {
    throw new Error(/did not approve|canceled|cancelled|closed/i.test(e?.message || '') ? '已取消登录' : 'Google 登录失败：' + (e?.message || ''));
  }
  const back = new URL(result);
  const params = new URLSearchParams(back.hash.slice(1) || back.search.slice(1));
  if (params.get('error')) throw new Error(friendly(params.get('error_description') || params.get('error'), 400));
  const access = params.get('access_token');
  if (!access) throw new Error('Google 登录失败：未收到登录令牌');
  // 令牌中只有用户 ID，补取邮箱
  const user = await call('/auth/v1/user', { token: access });
  await saveSession({
    access_token: access,
    refresh_token: params.get('refresh_token'),
    expires_in: Number(params.get('expires_in') || 3600),
    user,
  });
  return { account: await refreshAccount() };
}

export async function signOut() {
  const auth = await getAuth();
  if (auth) await call('/auth/v1/logout', { method: 'POST', token: auth.access_token }).catch(() => {});
  await clearSession();
  return true;
}

/**
 * 开发版切换后端：local = 本机 Supabase，cloud = config.js 中的云端。
 * 两边的账号互不相通，切换时退出本地登录状态（不请求旧后端）。
 */
export async function devBackend({ target } = {}) {
  const dev = await isDevInstall();
  if (target) {
    if (!dev) throw new Error('只有开发版可以切换后端');
    if (target === 'local') await chrome.storage.local.set({ backendOverride: LOCAL_DEV_BACKEND });
    else await chrome.storage.local.remove('backendOverride');
    await clearSession();
  }
  return { dev, cloudConfigured: filled(BACKEND), ...(await backendInfo()) };
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
  const month = new Date().toISOString().slice(0, 7);
  const usageRows = await call(`/rest/v1/usage_monthly?month=eq.${month}&select=tokens,chars`, { token }).catch(() => []);
  const account = {
    email: p.email || auth.user.email,
    plan: ['premium', 'premium_plus'].includes(p.plan) ? p.plan : 'free',
    usage: { tokens: Number(usageRows?.[0]?.tokens || 0), chars: Number(usageRows?.[0]?.chars || 0), limit: TOKEN_LIMIT, month },
    status: p.subscription_status || null,
    periodEnd: p.current_period_end || null,
    cancelAtPeriodEnd: !!p.cancel_at_period_end,
    hasBilling: !!p.subscription_status, // 有过订阅才有账单；只点过“开通”但没付款的不算
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({ [ACCOUNT_KEY]: account });
  if (isMember(account.plan)) syncWords().catch(() => {}); // 登录或续费后拉取云端生词本
  return account;
}

// ---------- 后端翻译 ----------
const TOKEN_LIMIT = 20_000_000; // Premium+ 每月 Token（与后端 TOKEN_LIMIT_MONTHLY 一致，仅用于显示）
const ENGINE_NAME = { deepl: 'DeepL', microsoft: 'Microsoft 翻译', openai: 'OpenAI GPT', gemini: 'Google Gemini', deepseek: 'DeepSeek', claude: 'Claude' };
const isMember = (plan) => plan === 'premium' || plan === 'premium_plus';

/** DeepL、Microsoft 与全部大模型：由后端调用，校验会员等级与本月用量 */
export async function backendTranslate({ engine, texts, from, to }) {
  const name = ENGINE_NAME[engine] || engine;
  const token = await getToken().catch(() => null);
  if (!token) {
    const e = new Error(`${name} 需要登录并开通会员后使用`);
    e.code = 'login';
    throw e;
  }
  // 后端单次最多 100 段 / 2 万字符；按 50 段 / 1 万字符分批，避免长字幕等大请求被拒
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const t of texts) {
    if (cur.length && (cur.length >= 50 || size + t.length > 10000)) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(t);
    size += t.length;
  }
  if (cur.length) chunks.push(cur);
  const out = [];
  let usage = null;
  for (const part of chunks) {
    const data = await call('/functions/v1/translate', { method: 'POST', token, body: { engine, texts: part, from, to } });
    out.push(...data.translations);
    if (data?.usage) usage = data.usage;
  }
  if (usage) {
    const { account } = await chrome.storage.local.get(ACCOUNT_KEY);
    if (account) await chrome.storage.local.set({ [ACCOUNT_KEY]: { ...account, usage: { ...account.usage, ...usage } } });
  }
  return out;
}

// ---------- 生词本云同步（会员功能） ----------
// 本地 words 每项带 u（最后修改时间）；删除记入 wordsTombstones { key: 删除时间 }。
// 与云端 words 表逐词比较 updated_at，较新者为准；删除以墓碑同步到其他设备。
const keyOf = (w) => String(w).trim().toLowerCase();
let lastSynced = '';

export async function markWordDeleted(key, ts = Date.now()) {
  const { wordsTombstones = {} } = await chrome.storage.local.get('wordsTombstones');
  wordsTombstones[key] = ts;
  await chrome.storage.local.set({ wordsTombstones });
}

export async function syncWords() {
  const { [ACCOUNT_KEY]: account } = await chrome.storage.local.get(ACCOUNT_KEY);
  if (!isMember(account?.plan)) return { skipped: true };
  const token = await getToken();
  if (!token) return { skipped: true };
  const auth = await getAuth();
  const remote = (await call('/rest/v1/words?select=key,w,t,url,ts,m,deleted,updated_at&limit=10000', { token })) || [];
  const { words = [], wordsTombstones = {} } = await chrome.storage.local.get(['words', 'wordsTombstones']);

  const local = new Map();
  for (const w of words) {
    local.set(keyOf(w.w), { key: keyOf(w.w), w: w.w, t: w.t || '', url: w.url || '', ts: w.ts || 0, m: !!w.m, deleted: false, updated_at: w.u || w.ts || 0 });
  }
  for (const [k, ts] of Object.entries(wordsTombstones)) {
    const cur = local.get(k);
    if (!cur || ts >= cur.updated_at) local.set(k, { key: k, w: cur?.w || k, t: '', url: '', ts: cur?.ts || 0, m: false, deleted: true, updated_at: ts });
  }
  const merged = new Map(local);
  const push = [];
  const remoteMap = new Map(remote.map((r) => [r.key, { ...r, updated_at: Number(r.updated_at), ts: Number(r.ts) }]));
  for (const [k, l] of local) {
    const r = remoteMap.get(k);
    if (!r || l.updated_at > r.updated_at) push.push({ ...l, user_id: auth.user.id });
  }
  for (const [k, r] of remoteMap) {
    const l = local.get(k);
    if (!l || r.updated_at > l.updated_at) merged.set(k, r);
  }
  for (let i = 0; i < push.length; i += 500) {
    await call('/rest/v1/words?on_conflict=user_id,key', {
      method: 'POST',
      token,
      body: push.slice(i, i + 500),
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    });
  }
  const next = [...merged.values()]
    .filter((x) => !x.deleted)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 5000)
    .map((x) => ({ w: x.w, t: x.t, url: x.url, ts: x.ts, m: !!x.m, u: x.updated_at }));
  lastSynced = JSON.stringify([next, {}]);
  await chrome.storage.local.set({ words: next, wordsTombstones: {}, wordsSyncedAt: Date.now() });
  return { pushed: push.length, total: next.length };
}

/** 生词变化后 2 秒自动同步；同步自身写入的变化不再触发 */
export function watchWordSync() {
  let timer = 0;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || (!changes.words && !changes.wordsTombstones)) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const { words = [], wordsTombstones = {} } = await chrome.storage.local.get(['words', 'wordsTombstones']);
      if (JSON.stringify([words, wordsTombstones]) === lastSynced) return;
      syncWords().catch(() => {});
    }, 2000);
  });
}

export async function accountState() {
  const configured = await isConfigured();
  const auth = await getAuth();
  const { account } = await chrome.storage.local.get(ACCOUNT_KEY);
  return { configured, loggedIn: !!auth, email: auth?.user?.email || null, account: account || null, backend: await backendInfo() };
}

// 一次支付 / 管理订阅的上下文：从哪个标签页发起、要开通哪个方案。放在 session 存储，浏览器关闭即清除
const FLOW_KEY = 'billingFlow';
const flowStore = () => chrome.storage.session || chrome.storage.local;

/**
 * 发起支付的位置：premium = 方案页标签；page = 网页（从网页内侧面板发起）；extension = 其他扩展页面；null = 弹窗等没有标签页的地方。
 * 没有 tabs 权限时读不到扩展页面标签的 URL，所以在发起时根据消息来源记下来。
 */
export function originOf(sender) {
  if (!sender?.tab) return null;
  const ext = chrome.runtime.getURL('');
  const kind = sender.url?.startsWith(ext + 'premium/') ? 'premium' : sender.url?.startsWith(ext) && sender.frameId === 0 ? 'extension' : 'page';
  return { tabId: sender.tab.id, kind };
}

async function openBilling(fn, body, origin) {
  const token = await getToken();
  if (!token) throw new Error('请先登录');
  const { url } = await call(`/functions/v1/${fn}`, { method: 'POST', token, body });
  const { [ACCOUNT_KEY]: account } = await chrome.storage.local.get(ACCOUNT_KEY);
  await flowStore().set({
    [FLOW_KEY]: { kind: fn === 'billing-portal' ? 'portal' : 'checkout', plan: body.plan || null, prevPlan: account?.plan || 'free', origin: origin || null, at: Date.now() },
  });
  await chrome.tabs.create({ url });
  return true;
}

/**
 * plan：premium（仅年付）| premium_plus（月付 / 年付）。已是会员时后端返回 use_portal，改为打开客户门户升级或切换。
 * origin：发起支付的位置（originOf），支付完成后回到这里并显示结果
 */
export async function checkout({ plan = 'premium_plus', interval = 'year' }, origin) {
  try {
    await openBilling('billing-checkout', { plan, interval: plan === 'premium' ? 'year' : interval === 'month' ? 'month' : 'year' }, origin);
    return { opened: 'checkout' };
  } catch (e) {
    if (e.code !== 'use_portal') throw e;
    await openPortal(origin);
    return { opened: 'portal' };
  }
}
export const openPortal = (origin) => openBilling('billing-portal', {}, origin);

/** 给用户看的支付结果 */
export function billingResultText(r) {
  if (r.status === 'success') return `支付成功！你现在是 ${PLAN_NAME[r.plan]} 会员`;
  if (r.status === 'pending') return '支付已完成，会员正在开通，稍后会自动生效';
  if (r.status === 'cancel') return '已取消支付，没有产生任何费用';
  return r.plan && r.plan !== 'free' ? `订阅已更新，当前为 ${PLAN_NAME[r.plan]} 会员` : '订阅已更新，当前为免费版';
}

const PREMIUM_PAGE = () => chrome.runtime.getURL('premium/premium.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 关闭支付标签页，回到发起支付的页面并显示结果；原页面已关闭时，在支付标签页中打开方案页显示结果 */
async function returnToOrigin(payTabId, flow, result) {
  const kind = flow?.origin?.kind;
  const origin = flow?.origin ? await chrome.tabs.get(flow.origin.tabId).catch(() => null) : null;
  const toPremium = origin ? kind === 'premium' : result.status !== 'portal';
  if (toPremium) await chrome.storage.local.set({ billingResult: result }); // 方案页读取后显示并清除
  if (origin) {
    await chrome.tabs.update(origin.id, { active: true });
    await chrome.windows.update(origin.windowId, { focused: true }).catch(() => {});
    if (kind === 'page') {
      // 从网页内的侧面板发起：在网页上提示
      chrome.tabs.sendMessage(origin.id, { type: 'billingResult', text: billingResultText(result), ok: result.status !== 'cancel' }).catch(() => {});
    }
    await chrome.tabs.remove(payTabId).catch(() => {});
  } else if (toPremium) {
    await chrome.tabs.update(payTabId, { url: PREMIUM_PAGE() });
  }
}

// 支付 / 管理订阅返回页打开时：等 webhook 把会员状态写入数据库（可能晚几秒），然后回到发起支付的页面并告知结果
const handledReturns = new Set();
export function watchBillingReturn() {
  chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
    if (info.status !== 'complete' || !tab.url) return;
    let base;
    try {
      base = (await backend()).url;
    } catch {
      return;
    }
    if (!tab.url.startsWith(`${base}/functions/v1/billing-return`)) return;
    const status = new URL(tab.url).searchParams.get('status') || 'success';
    if (status === 'verified') return; // 邮箱验证落地页，与支付无关
    const once = `${tabId}|${tab.url}`;
    if (handledReturns.has(once)) return;
    handledReturns.add(once);

    const { [FLOW_KEY]: flow } = await flowStore().get(FLOW_KEY);
    const want = flow?.plan || 'premium';
    let account = null;
    let confirmed = false;
    if (status !== 'cancel') {
      for (const wait of [0, 1500, 2500, 4000, 6000, 8000, 10000]) {
        await sleep(wait);
        account = await refreshAccount().catch(() => account);
        confirmed = status === 'success' && !!account && (PLAN_RANK[account.plan] || 0) >= (PLAN_RANK[want] || 1);
        if (confirmed || (status === 'portal' && wait >= 1500)) break;
      }
    }
    const result = {
      status: status === 'success' ? (confirmed ? 'success' : 'pending') : status === 'cancel' ? 'cancel' : 'portal',
      plan: account?.plan || flow?.prevPlan || 'free',
      at: Date.now(),
    };
    await flowStore().remove(FLOW_KEY);
    await returnToOrigin(tabId, flow, result);
  });
}
