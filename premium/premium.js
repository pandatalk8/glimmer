// 会员方案页：三档方案、月付 / 年付切换、功能对比；未登录时弹出登录窗口，登录后继续支付
import { PLAN_NAME, ENGINES, getSettings, saveSettings } from '../src/shared/settings.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// 价格（美元）与 Stripe 中的价格一致；修改价格时需同时修改 scripts/setup_stripe.py
const PRICE = {
  premium: { year: 29 },
  premium_plus: { month: 6, year: 69 },
};
const money = (n) => '$' + (Number.isInteger(n) ? n : n.toFixed(2));

const check = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.6-5"/></svg>';

const PLANS = [
  {
    id: 'free',
    title: '微光翻译',
    section: '基础功能免费',
    features: [
      ['网页双语对照翻译', '按段落插入译文，只翻译看得见的内容'],
      ['划词、悬停、输入框翻译'],
      ['YouTube 双语字幕', '自动字幕合并成句，点击单词查释义'],
      ['Google 翻译'],
      ['生词本（最多 100 个）'],
      ['侧边面板与 8 种译文样式'],
    ],
  },
  {
    id: 'premium',
    title: 'Premium',
    badge: '最超值',
    section: 'Premium 高级功能',
    features: [
      ['免费版全部功能'],
      ['无限生词本', '收藏单词与句子不限数量'],
      ['生词本云同步', '换电脑、重装插件后登录即可恢复'],
      ['DeepL 专业翻译', '欧洲语言翻译质量出色'],
      ['Microsoft 翻译'],
    ],
  },
  {
    id: 'premium_plus',
    title: 'Premium+ 高级 AI',
    badge: '最多人购买',
    section: 'Premium 功能 + 高级 AI 引擎',
    features: [
      ['Premium 全部功能'],
      ['OpenAI GPT'],
      ['Google Gemini'],
      ['DeepSeek'],
      ['Anthropic Claude'],
    ],
    note: '每月可用 2000 万 Token，满足日常阅读、学习与工作中的高质量翻译需求。',
  },
];

const COMPARE = [
  ['基础功能'],
  ['网页双语对照翻译', '✓', '✓', '✓'],
  ['划词 / 悬停 / 输入框翻译', '✓', '✓', '✓'],
  ['YouTube 双语字幕', '✓', '✓', '✓'],
  ['侧边面板与译文样式', '✓', '✓', '✓'],
  ['生词本', '100 个', '无限', '无限'],
  ['生词本云同步', '—', '✓', '✓'],
  ['翻译引擎'],
  ['Google 翻译', '✓', '✓', '✓'],
  ['DeepL', '—', '✓', '✓'],
  ['Microsoft 翻译', '—', '✓', '✓'],
  ['OpenAI GPT、Google Gemini、DeepSeek、Anthropic Claude', '—', '—', '2000 万 Token / 月'],
];

const RANK = { free: 0, premium: 1, premium_plus: 2 };
let interval = 'year';
let state = { loggedIn: false, configured: true, account: null, email: null };
let pending = null; // 登录后要继续的方案
let ready = false; // 首次加载完成前的状态变化不算“新登录”

try {
  interval = localStorage.getItem('gl-interval') || 'year';
} catch {}

async function send(type, data = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...data });
  if (!r?.ok) throw new Error(r?.error || '操作失败');
  return r.data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2400);
}

function notice(msg, kind = 'ok') {
  const n = $('#notice');
  n.hidden = !msg;
  n.className = 'notice ' + kind;
  n.textContent = msg || '';
}

const myPlan = () => state.account?.plan || 'free';

function priceBlock(p) {
  if (p.id === 'free') return `<div class="price"><b>免费</b></div><div class="sub">永久免费</div>`;
  if (p.id === 'premium') {
    return `<div class="price"><b>${money(PRICE.premium.year / 12)}</b><span>/ 月</span></div>
            <div class="sub">${money(PRICE.premium.year)} / 年，仅年付</div>`;
  }
  const pr = PRICE.premium_plus;
  return interval === 'month'
    ? `<div class="price"><b>${money(pr.month)}</b><span>/ 月</span></div><div class="sub">按月付费，随时取消</div>`
    : `<div class="price"><b>${money(pr.year / 12)}</b><span>/ 月</span></div>
       <div class="sub">${money(pr.year)} / 年<s>${money(pr.month * 12)} / 年</s></div>`;
}

function cta(p) {
  const mine = myPlan();
  if (p.id === 'free') {
    return mine === 'free'
      ? '<button class="btn ghost" disabled>当前方案</button>'
      : '<button class="btn ghost" disabled>已包含在你的会员中</button>';
  }
  if (mine === p.id) return '<button class="btn ghost" data-act="portal">当前方案 · 管理订阅</button>';
  if (RANK[mine] > RANK[p.id]) return '<button class="btn ghost" disabled>已包含在你的会员中</button>';
  const label = mine === 'free' ? `开通 ${PLAN_NAME[p.id]}` : `升级到 ${PLAN_NAME[p.id]}`;
  return `<button class="btn ${p.id === 'premium' ? 'shine' : 'solid'}" data-act="buy" data-plan="${p.id}">${label}</button>`;
}

function render() {
  document.querySelectorAll('#period button').forEach((b) => b.classList.toggle('on', b.dataset.interval === interval));
  $('#plans').innerHTML = PLANS.map(
    (p) => `
    <article class="plan ${p.id} ${myPlan() === p.id ? 'current' : ''}">
      ${p.badge ? `<span class="badge">${p.badge}</span>` : ''}
      ${myPlan() === p.id ? '<span class="mine">当前方案</span>' : ''}
      <h3>${p.title}</h3>
      ${priceBlock(p)}
      ${cta(p)}
      <div class="sec-title"><span>${p.section}</span></div>
      <ul>${p.features.map(([t, d]) => `<li>${check}<div><b>${t}</b>${d ? `<small>${d}</small>` : ''}</div></li>`).join('')}</ul>
      ${p.note ? `<p class="note">${p.note}</p>` : ''}
    </article>`
  ).join('');
  $('#compare').innerHTML =
    '<thead><tr><th></th><th>免费</th><th>Premium</th><th>Premium+ 高级 AI</th></tr></thead><tbody>' +
    COMPARE.map((r) =>
      r.length === 1
        ? `<tr class="group"><td colspan="4">${r[0]}</td></tr>`
        : `<tr><td>${r[0]}</td>${r.slice(1).map((c) => `<td class="${c === '—' ? 'no' : ''}">${c}</td>`).join('')}</tr>`
    ).join('') +
    '</tbody>';
  $('#who').innerHTML = state.loggedIn
    ? `<span class="email">${esc(state.email || '')}</span><span class="pill ${myPlan() !== 'free' ? 'on' : ''}">${PLAN_NAME[myPlan()]}</span>`
    : '<button class="btn small ghost" data-act="login">登录</button>';
}

async function load(refresh = false) {
  try {
    state = await send(refresh ? 'accountRefresh' : 'accountState');
  } catch {
    state = await send('accountState').catch(() => state);
  }
  render();
}

// ---------- 登录弹窗 ----------
function openLogin(after) {
  pending = after || null;
  $('#loginFrame').src = chrome.runtime.getURL('panel/panel.html?view=account');
  $('#loginModal').hidden = false;
}
function closeLogin() {
  $('#loginModal').hidden = true;
  $('#loginFrame').src = 'about:blank';
}

async function buy(plan) {
  if (!state.configured) return notice('账户服务尚未配置，暂时无法订阅', 'err');
  if (!state.loggedIn) return openLogin({ plan });
  notice('正在打开支付页面…');
  try {
    const r = await send('billingCheckout', { plan, interval });
    notice(
      r?.opened === 'portal'
        ? '你已经是会员：已在新标签页打开订阅管理，在那里升级或切换方案'
        : '已在新标签页打开 Stripe 支付页面。完成支付后会自动回到这里，并告诉你开通结果'
    );
  } catch (e) {
    notice(e.message, 'err');
  }
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.interval) {
    interval = b.dataset.interval;
    try {
      localStorage.setItem('gl-interval', interval);
    } catch {}
    return render();
  }
  const act = b.dataset.act;
  if (act === 'buy') return buy(b.dataset.plan);
  if (act === 'login') return openLogin();
  if (act === 'portal') return send('billingPortal').catch((err) => notice(err.message, 'err'));
});
$('#closeLogin').onclick = closeLogin;
$('#loginModal').addEventListener('click', (e) => e.target.id === 'loginModal' && closeLogin());

// 登录、支付后状态变化：刷新页面内容；登录成功时继续之前选择的方案
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || (!changes.auth && !changes.account) || !ready) return;
  const wasLoggedIn = state.loggedIn;
  await load();
  if (!wasLoggedIn && state.loggedIn) {
    closeLogin();
    toast('登录成功');
    if (pending?.plan) {
      const p = pending.plan;
      pending = null;
      if (RANK[myPlan()] < RANK[p]) buy(p);
    }
  }
});

// ---------- 支付结果：后台在支付完成后切回本页，并写入 billingResult ----------
const UNLOCKED = {
  premium: ['生词本不限数量，自动云同步', 'DeepL 专业翻译', 'Microsoft 翻译'],
  premium_plus: ['生词本不限数量，自动云同步', 'DeepL、Microsoft 专业翻译', 'GPT、Gemini、DeepSeek、Claude 四家大模型', '每月 2000 万 Token'],
};
const RESULT_TEXT = {
  pending: '支付已完成，会员正在开通，稍后会自动生效',
  cancel: '已取消支付，没有产生任何费用',
};
async function showBillingResult() {
  const { billingResult: r } = await chrome.storage.local.get('billingResult');
  if (!r || Date.now() - r.at > 10 * 60 * 1000) return;
  await chrome.storage.local.remove('billingResult');
  await load();
  if (r.status === 'success') {
    $('#doneText').innerHTML = `你现在是 <b>${esc(PLAN_NAME[r.plan])}</b> 会员，以下功能已解锁：`;
    $('#doneList').innerHTML = (UNLOCKED[r.plan] || []).map((x) => `<li>${esc(x)}</li>`).join('');
    // 付完钱马上能用：直接选择默认翻译引擎
    const cur = (await getSettings()).engine;
    const picks = [...(SUGGEST[r.plan] || []), 'google'];
    chosen = picks[0];
    $('#doneEngines').innerHTML = `<div class="pe-title">选择默认翻译引擎</div>` + picks
      .map((id) => `<button class="pe ${id === chosen ? 'on' : ''}" data-engine="${id}">${esc(id === 'google' ? (cur === 'google' ? '保持 Google 翻译' : 'Google 翻译') : ENGINES.find((e) => e.id === id).name)}</button>`)
      .join('');
    const fromTab = FROM != null ? await chrome.tabs.get(FROM).catch(() => null) : null;
    $('#doneHint').textContent = fromTab ? '点击后回到你正在阅读的网页' : '';
    $('#doneModal').hidden = false;
    notice(`支付成功！你现在是 ${PLAN_NAME[r.plan]} 会员`);
  } else if (r.status === 'portal') {
    notice(r.plan !== 'free' ? `订阅已更新，当前为 ${PLAN_NAME[r.plan]} 会员` : '订阅已更新，当前为免费版');
  } else {
    notice(RESULT_TEXT[r.status] || '', r.status === 'cancel' ? 'err' : 'ok');
  }
}
// 开通后推荐的默认引擎（第一个为默认选中）
const SUGGEST = { premium: ['deepl'], premium_plus: ['deepseek', 'deepl'] };
const FROM = (() => {
  const v = new URLSearchParams(location.search).get('from');
  return v && /^\d+$/.test(v) ? Number(v) : null;
})();
let chosen = null;
$('#doneEngines').addEventListener('click', (e) => {
  const b = e.target.closest('[data-engine]');
  if (!b) return;
  chosen = b.dataset.engine;
  $$('#doneEngines .pe').forEach((x) => x.classList.toggle('on', x === b));
});
// “开始使用”：保存默认引擎，回到打开方案页之前正在阅读的网页，并关闭方案页
$('#doneOk').onclick = async () => {
  if (chosen) await saveSettings({ engine: chosen });
  $('#doneModal').hidden = true;
  if (FROM == null) return;
  const back = await chrome.tabs.update(FROM, { active: true }).catch(() => null);
  if (!back) return;
  chrome.windows.update(back.windowId, { focused: true }).catch(() => {});
  const me = await chrome.tabs.getCurrent();
  if (me) chrome.tabs.remove(me.id);
};
chrome.storage.onChanged.addListener((c, area) => area === 'local' && c.billingResult?.newValue && showBillingResult());

render();
load(true).finally(() => (ready = true));
showBillingResult();
