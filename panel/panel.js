// 面板：工具栏弹窗与网页内侧边抽屉共用同一页面
import { getSettings, saveSettings, ENGINES, hostMatches, canUse, PLAN_NAME, FREE_WORD_LIMIT } from '../src/shared/settings.js';
import { LANGUAGES, TARGET_LANGUAGES, getLang } from '../src/shared/languages.js';
import { buildShort } from '../src/shared/build.js';
import { TERMS } from '../src/shared/config.js';

const qs = new URLSearchParams(location.search);
const MODE = qs.get('mode') === 'drawer' ? 'drawer' : 'popup';
document.documentElement.dataset.mode = MODE;
const VERSION = chrome.runtime.getManifest().version;
const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------------- 图标（线性，24px 网格） ----------------
const svg = (d, size = 20) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const IC = {
  close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  home: svg('<rect x="3" y="3" width="7.5" height="7.5" rx="2.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2.5"/>'),
  gear: svg('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
  translate: svg('<path d="m5 8 6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6"/>'),
  cursor: svg('<path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2"/><path d="M9 9h6M12 9v7"/>'),
  video: svg('<rect x="2" y="4" width="20" height="16" rx="3"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/>'),
  book: svg('<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><path d="M9 7h6"/>'),
  sliders: svg('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'),
  chev: svg('<path d="m9 18 6-6-6-6"/>', 18),
  back: svg('<path d="m15 18-6-6 6-6"/>', 22),
  check: svg('<path d="M20 6 9 17l-5-5"/>', 20),
  heart: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7.5-4.6-9.6-9.2C1 8.6 3 5 6.6 5c2 0 3.4 1.1 4.4 2.5C12 6.1 13.4 5 15.4 5 19 5 21 8.6 19.6 11.8 17.5 16.4 12 21 12 21z"/></svg>`,
  engine: svg('<rect x="3" y="5" width="16" height="15" rx="3"/><path d="M7 16l2.5-7 2.5 7M7.9 13.6h3.2M15 9v7"/><path d="M20 2.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z" fill="currentColor" stroke="none"/>', 24),
  style: svg('<path d="M4 20h16M6 16l6-12 6 12M8.5 11h7"/>'),
  mouse: svg('<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/>'),
  keyboard: svg('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M8 16h8M10 13h4"/>'),
  ball: svg('<rect x="4" y="4" width="16" height="16" rx="3"/><rect x="9" y="9" width="6" height="6" rx="1"/>'),
  globe: svg('<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
  detect: svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3M8 11h6M11 8v6"/>'),
  input: svg('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10v4M11 12h6"/>'),
  sites: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  key: svg('<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>'),
  info: svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'),
  inbox: svg('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>', 34),
  speak: svg('<path d="M11 5 6 9H2v6h4l5 4V5zM15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/>', 16),
  trash: svg('<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>', 16),
  checkSq: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="m8.5 12.2 2.4 2.4 4.6-5"/>', 18),
  heartSm: `<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7.5-4.6-9.6-9.2C1 8.6 3 5 6.6 5c2 0 3.4 1.1 4.4 2.5C12 6.1 13.4 5 15.4 5 19 5 21 8.6 19.6 11.8 17.5 16.4 12 21 12 21z"/></svg>`,
  down: svg('<path d="m6 9 6 6 6-6"/>', 14),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  crown: svg('<path d="M3 7l4.5 4L12 4l4.5 7L21 7l-2 12H5L3 7z"/>', 16),
  card: svg('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>', 18),
  google: `<svg width="20" height="20" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`,
  mail: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>', 18),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/><circle cx="12" cy="16" r="1" fill="currentColor"/>', 18),
  refresh: svg('<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>', 16),
};

// ---------------- 状态 ----------------
let S = await getSettings();
let words = (await chrome.storage.local.get('words')).words || [];
let tab = null;
let host = '';
let page = { supported: false, active: false };
let view = qs.get('view') || 'home';
let history = [];
let quick = { text: '', out: '', err: false };
let build = null; // 当前加载的代码版本（buildInfo）
let pageWords = []; // 生词本中出现在当前网页上的词
let expanded = false; // “展开释义”
try {
  expanded = localStorage.getItem('gl-expand') === '1';
} catch {}

// 账户：{ configured, loggedIn, email, account: { plan, status, periodEnd, cancelAtPeriodEnd, hasBilling } }
let acct = { configured: false, loggedIn: false, email: null, account: null };
let auth = { mode: 'signin', email: '', msg: '', kind: '', busy: false };
const plan = () => acct.account?.plan || 'free';
const isMember = () => plan() !== 'free';
const USAGE_WARN = 80; // Premium+ 本月用量达到这个百分比时提醒
const usagePct = () => {
  const u = acct.account?.usage || {};
  return Math.min(100, Math.round(((u.points || 0) / (u.limit || 15e6)) * 100));
};
// 升级提示卡：点到需要会员的功能时，在面板内说明需要的等级、价格和权益
const OFFER = {
  premium: { price: '$29 / 年', perks: ['DeepL、Microsoft 专业翻译（每月 10 万字符）', '生词本不限数量', '生词本云同步，换设备不丢'] },
  premium_plus: { price: '$6 / 月 或 $69 / 年', perks: ['包含 Premium 全部功能', 'DeepSeek、Claude 大模型（GPT、Gemini 即将开放）', '每月 1500 万 AI 点数'] },
};
function showUpsell(e) {
  document.querySelector('.upsell')?.remove();
  const tier = e.tier === 'free' ? 'premium' : e.tier;
  const o = OFFER[tier];
  const el = document.createElement('div');
  el.className = 'upsell';
  el.innerHTML = `<div class="up-card" role="dialog">
      <div class="up-title">${IC.crown}<span>${esc(e.name)} 需要 ${PLAN_NAME[tier]} 会员</span></div>
      <div class="up-price">${PLAN_NAME[tier]} · ${o.price}</div>
      <ul>${o.perks.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      <button class="gold" data-up="go">查看会员方案</button>
      ${acct.loggedIn ? '' : '<button class="link up-login" data-up="login">已经是会员？登录</button>'}
      <button class="link" data-up="close">以后再说</button>
    </div>`;
  el.addEventListener('click', (ev) => {
    const a = ev.target.closest('[data-up]')?.dataset.up;
    if (ev.target === el || a === 'close') return el.remove();
    if (a === 'go') {
      el.remove();
      openPremium();
    }
    if (a === 'login') {
      el.remove();
      go('account');
    }
  });
  document.body.appendChild(el);
}

function openPremium() {
  chrome.runtime.sendMessage({ type: 'openPremium' }).then(() => MODE === 'popup' && window.close());
}

async function send(type, data = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...data });
  if (!r?.ok) throw new Error(r?.error || '操作失败');
  return r.data;
}

async function loadAccount(refresh = false) {
  try {
    acct = await send(refresh ? 'accountRefresh' : 'accountState');
  } catch (e) {
    if (refresh) acct = await send('accountState').catch(() => acct);
  }
}

const keyOf = (w) => String(w).trim().toLowerCase();
const findWord = (k) => words.find((w) => keyOf(w.w) === k);

async function refreshPageWords() {
  pageWords = [];
  if (!page.supported || !words.length) return;
  try {
    const hits = await chrome.tabs.sendMessage(tab.id, { type: 'pageWords', words: words.map((w) => w.w) }, { frameId: 0 });
    const set = new Set((hits || []).map(keyOf));
    pageWords = words.filter((w) => set.has(keyOf(w.w))).sort((a, b) => a.w.localeCompare(b.w, 'en'));
  } catch {}
}

async function saveWords(next) {
  words = next;
  await chrome.storage.local.set({ words });
}

async function resolveTab() {
  if (MODE === 'drawer') {
    const r = await chrome.runtime.sendMessage({ type: 'tabInfo' }).catch(() => null);
    return r?.ok ? r.data : null;
  }
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t || null;
}

async function refreshPage() {
  if (!tab?.id) return (page = { supported: false, active: false });
  try {
    const st = await chrome.tabs.sendMessage(tab.id, { type: 'getState' }, { frameId: 0 });
    page = { supported: !!st, active: !!st?.active };
  } catch {
    page = { supported: false, active: false };
  }
}

async function save(patch) {
  S = await saveSettings(patch);
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 1600);
}

function openOptions(hash = '') {
  chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') + (hash ? '#' + hash : '') });
  if (MODE === 'popup') window.close();
}

function close() {
  if (MODE === 'popup') window.close();
  else parent.postMessage({ source: 'glimmer-panel', type: 'close' }, '*');
}

// ---------------- 选项定义 ----------------
const onOff = [
  ['on', '已开启'],
  ['off', '已关闭'],
];
const engineOf = (id) => ENGINES.find((e) => e.id === id);
const langOpts = (list) => list.map((l) => [l.code, l.name]);

const PICKERS = {
  engine: {
    title: '翻译引擎',
    get: (s) => s.engine,
    set: (v) => ({ engine: v }),
    options: () =>
      ENGINES.map((e) => [
        e.id,
        e.name,
        e.soon
          ? '<span class="tag soon">即将开放</span>'
          : e.tier === 'free'
            ? '<span class="tag free">免费</span>'
            : `<span class="tag ${canUse(plan(), e.id) ? 'pro' : 'need'}">${PLAN_NAME[e.tier]}</span>`,
        e.tier === 'free' ? '浏览器直接翻译' : e.type === 'llm' ? '大模型 · 由微光翻译服务器提供' : '由微光翻译服务器提供',
      ]),
    footer: '<button class="link" data-act="premium">查看会员方案 ' + IC.chev + '</button>',
    // 未解锁的引擎不切换：先在面板内说明需要什么，用户点“查看会员方案”才打开方案页
    guard: (v) => {
      if (engineOf(v)?.soon) {
        toast(`${engineOf(v).name} 即将开放，暂时请使用其他引擎`);
        return false;
      }
      if (canUse(plan(), v) && (v === 'google' || acct.loggedIn)) return true;
      showUpsell(engineOf(v));
      return false;
    },
  },
  youtube: {
    title: '双语字幕',
    get: (s) => (s.youtube.enabled ? 'on' : 'off'),
    set: (v) => ({ youtube: { enabled: v === 'on' } }),
    options: () => onOff,
    hint: '在 YouTube 打开字幕（CC）后显示原文 + 译文。',
  },
  displayMode: {
    title: '沉浸翻译',
    get: (s) => s.displayMode,
    set: (v) => ({ displayMode: v }),
    options: () => [
      ['bilingual', '对照翻译', '', '原文下方显示译文'],
      ['translation', '仅显示译文', '', '隐藏原文，只保留译文'],
    ],
    hint: '快捷键 Alt+S 可随时切换。',
  },
  transStyle: {
    title: '译文样式',
    get: (s) => s.transStyle,
    set: (v) => ({ transStyle: v }),
    options: () => [
      ['none', '默认'],
      ['underline', '下划线'],
      ['dashed', '虚线'],
      ['highlight', '高亮'],
      ['border', '引用条'],
      ['weak', '弱化'],
      ['color', '彩色'],
      ['blur', '学习模式', '', '译文模糊，鼠标悬停显示'],
    ],
  },
  selection: {
    title: '划词翻译',
    get: (s) => (s.selection.enabled ? s.selection.trigger : 'off'),
    set: (v) => (v === 'off' ? { selection: { enabled: false } } : { selection: { enabled: true, trigger: v } }),
    options: () => [
      ['icon', '显示按钮', '', '选中文字后出现图标，点击翻译'],
      ['auto', '直接翻译', '', '选中文字后立即弹出译文'],
      ['off', '已关闭'],
    ],
  },
  hover: {
    title: '悬停翻译',
    get: (s) => (s.hover.enabled ? s.hover.key : 'off'),
    set: (v) => (v === 'off' ? { hover: { enabled: false } } : { hover: { enabled: true, key: v } }),
    options: () => [
      ['Alt', 'Alt / Option'],
      ['Control', 'Ctrl'],
      ['Shift', 'Shift'],
      ['off', '已关闭'],
    ],
    hint: '按住按键并指向段落，只翻译这一段。',
  },
  inputTranslate: {
    title: '输入框翻译',
    get: (s) => (s.inputTranslate.enabled ? s.inputTranslate.targetLang : 'off'),
    set: (v) => (v === 'off' ? { inputTranslate: { enabled: false } } : { inputTranslate: { enabled: true, targetLang: v } }),
    options: () => [['off', '已关闭'], ...langOpts(TARGET_LANGUAGES)],
    hint: '在输入框末尾连按三次空格，把内容翻译成所选语言。',
  },
  floatBall: {
    title: '浮动按钮',
    get: (s) => (s.floatBall ? 'on' : 'off'),
    set: (v) => ({ floatBall: v === 'on' }),
    options: () => onOff,
  },
  targetLang: {
    title: '翻译语言',
    get: (s) => s.targetLang,
    set: (v) => ({ targetLang: v }),
    options: () => langOpts(TARGET_LANGUAGES),
  },
  sourceLang: {
    title: '网页语言',
    get: (s) => s.sourceLang,
    set: (v) => ({ sourceLang: v }),
    options: () => langOpts(LANGUAGES),
  },
};

const labelOf = (key) => {
  const p = PICKERS[key];
  const v = p.get(S);
  return p.options().find((o) => o[0] === v)?.[1] ?? v;
};

// ---------------- 视图 ----------------
function header(title) {
  if (!title) {
    return `<header class="hd">
      <div class="brand"><img src="../icons/icon48.png" alt="" /><span>微光翻译</span></div>
      <button class="chip premium ${isMember() ? 'on' : ''}" data-act="premium" title="会员方案">${isMember() ? IC.crown : ''}${plan() === 'premium_plus' ? 'Premium+' : 'Premium'}</button></header>`;
  }
  return `<header class="hd">
    ${history.length ? `<button class="back" data-act="back" title="返回">${IC.back}</button>` : ''}
    <h1>${esc(title)}</h1></header>`;
}

// 生词行：已掌握（勾选）、收藏（红心，点击取消）、朗读
function wordRows(list, showTrans) {
  return list
    .map((w) => {
      const k = esc(keyOf(w.w));
      return `<div class="word ${w.m ? 'mastered' : ''}">
        <div class="wtx"><b>${esc(w.w)}</b>${showTrans && w.t ? `<small>${esc(w.t)}</small>` : ''}</div>
        <button class="mini ${w.m ? 'ok' : ''}" data-act="master" data-k="${k}" title="${w.m ? '取消已掌握' : '标记为已掌握'}">${IC.checkSq}</button>
        <button class="mini heart" data-act="unsave" data-k="${k}" title="从生词本移除">${IC.heartSm}</button>
        <button class="mini" data-act="speak" data-k="${k}" title="朗读">${IC.speak}</button>
      </div>`;
    })
    .join('');
}

function expandBtn() {
  return `<button class="link ${expanded ? 'open' : ''}" data-act="expand">${expanded ? '收起释义' : '展开释义'} ${IC.down}</button>`;
}

const VIEWS = {
  home() {
    const eng = engineOf(S.engine);
    const always = !!host && hostMatches(host, S.alwaysSites);
    let wordsCard;
    if (!words.length) {
      wordsCard = `<div class="empty">${IC.inbox}<div>暂无生词，在划词翻译面板中<br/>点击 ☆ 收藏单词</div></div>`;
    } else if (!page.supported) {
      wordsCard = `<div class="wl-head"><span>最近收藏</span>${expandBtn()}</div>${wordRows(words.slice(0, 5), expanded)}`;
    } else if (!pageWords.length) {
      wordsCard = `<div class="wl-head"><span>本页生词 <em class="num">0</em></span></div>
        <div class="empty">${IC.inbox}<div>本页没有生词本中的单词</div>
        <button class="link" data-go="words">查看全部生词 ${IC.chev}</button></div>`;
    } else {
      wordsCard = `<div class="wl-head"><span>本页生词 <em class="num">${pageWords.length}</em></span>${expandBtn()}</div>${wordRows(pageWords, expanded)}`;
    }
    const staleBar = build?.stale
      ? `<div class="stale-bar"><span>插件代码已更新，请刷新插件后再检查</span><button class="link" data-act="openExt">去刷新 ${IC.chev}</button></div>`
      : '';
    // 选择的引擎暂时用不了（未登录、会员到期等）：翻译时自动改用 Google，这里说明原因并给出两个选择
    const paused = eng && eng.id !== 'google' && (!acct.loggedIn || !canUse(plan(), eng.id));
    const pausedBar = paused
      ? `<div class="engine-bar"><div>${IC.crown}<span>${esc(eng.name)} 需要${acct.loggedIn ? ` ${PLAN_NAME[eng.tier]} 会员` : '登录并开通会员'}，正在使用 Google 翻译</span></div>
          <div class="btns"><button class="gold sm" data-act="premium">${acct.loggedIn ? '开通会员' : '查看方案'}</button><button class="ghost sm" data-act="useGoogle">改用 Google</button></div></div>`
      : '';
    // Premium+ 用量接近或达到上限：首页提醒一次（点击查看账户页）
    const up = plan() === 'premium_plus' ? usagePct() : 0;
    const usageBar =
      up >= USAGE_WARN
        ? `<button class="usage-bar" data-go="account">${up >= 100 ? '本月 AI 点数已用完，大模型暂停到下月 1 日' : `本月 AI 点数已用 ${up}%`} ${IC.chev}</button>`
        : '';
    return `${header()}
    <div class="body">
      ${staleBar}
      ${pausedBar}
      ${usageBar}
      <div class="grid2">
        <button class="stat" data-go="words"><span class="si si-pink">${IC.heart}</span>
          <span><b>${words.length}</b><small>生词本</small></span></button>
        <button class="stat" data-pick="engine"><span class="si si-gold">${IC.engine}</span>
          <span><b>${esc(paused ? 'Google' : eng?.name.replace(/ 翻译$/, '') || S.engine)}</b><small>${paused ? `${esc(eng.name)} 已暂停` : '翻译引擎'}</small></span></button>
      </div>

      ${
        page.supported
          ? `<div class="card box hero ${page.active ? 'on' : ''}">
        <div class="line"><div><div class="t">翻译此页面</div>
          <div class="s">${esc(labelOf('displayMode'))} · ${esc(getLang(S.targetLang).name)}<kbd>Alt+A</kbd></div></div>
          <input type="checkbox" class="sw" data-act="togglePage" ${page.active ? 'checked' : ''} /></div>
      </div>
      <div class="card box">
        <div class="line"><span class="t">总在此网站开启</span>
          <input type="checkbox" class="sw" data-act="always" ${always ? 'checked' : ''} /></div>
        <div class="line"><span class="s">${esc(host)}</span>
          <button class="link" data-act="options" data-hash="sites">永不翻译 · ${S.neverSites.length} ${IC.chev}</button></div>
      </div>`
          : `<div class="warn">当前页面不支持网页翻译（浏览器内置页面，或安装扩展前已打开的页面，刷新后即可使用）。</div>`
      }

      <div class="card words-card">${wordsCard}</div>

      <div class="card box quick">
        <div class="q-head"><span class="t">快速翻译</span><span class="s">中英自动互译</span></div>
        <textarea id="quickInput" rows="2" placeholder="输入单词或句子">${esc(quick.text)}</textarea>
        <div class="q-actions"><span class="q-tip">Enter 翻译 · Shift+Enter 换行</span><button class="gold sm" data-act="quick">翻译</button></div>
        ${quick.out ? `<div class="qout ${quick.err ? 'err' : ''}" id="quickOut">${esc(quick.out)}</div>` : ''}
      </div>
    </div>`;
  },

  settings() {
    const row = (key, icon, color, label, extra = '') =>
      `<button class="ri" data-pick="${key}"><span class="ic ${color}">${icon}</span>
        <span class="lb">${label}${extra}</span><span class="val">${esc(labelOf(key))}</span><span class="chev">${IC.chev}</span></button>`;
    const link = (act, hash, icon, label, val = '') =>
      `<button class="ri" data-act="${act}" data-hash="${hash}"><span class="ic">${icon}</span>
        <span class="lb">${label}</span><span class="val">${val}</span><span class="chev">${IC.chev}</span></button>`;
    const acctVal = acct.loggedIn ? esc(acct.email || '') : '登录 / 注册';
    const acctTag = isMember() ? `<span class="tag pro">${IC.crown}${PLAN_NAME[plan()]}</span>` : '';
    return `${header('设置')}
    <div class="body">
      <div class="group">
        <button class="ri" data-go="account"><span class="ic">${IC.user}</span>
          <span class="lb">账户</span><span class="val">${acctVal}</span>${acctTag}<span class="chev">${IC.chev}</span></button>
        ${row('engine', IC.engine, '', '翻译引擎')}
      </div>
      <div class="group"><div class="gtitle">主功能设置</div>
        ${row('youtube', IC.video, 'c-red', '双语字幕')}
        ${row('displayMode', IC.translate, 'c-purple', '沉浸翻译')}
        ${row('transStyle', IC.style, 'c-purple', '译文样式')}
        ${row('selection', IC.cursor, 'c-blue', '划词翻译')}
        ${row('hover', IC.mouse, 'c-blue', '悬停翻译')}
        ${row('inputTranslate', IC.input, 'c-green', '输入框翻译')}
        ${row('floatBall', IC.ball, 'c-gold', '浮动按钮')}
      </div>
      <div class="group"><div class="gtitle">通用设置</div>
        ${row('targetLang', IC.globe, '', '翻译语言')}
        ${row('sourceLang', IC.detect, '', '网页语言')}
        ${link('options', 'sites', IC.sites, '网站规则', `${S.alwaysSites.length + S.neverSites.length} 条`)}
        ${link('shortcuts', '', IC.keyboard, '配置快捷键')}
      </div>
      <div class="group">
        ${link('options', '', IC.sliders, '完整设置')}
        ${link('options', 'advanced', IC.info, '关于', ['v' + VERSION, buildShort(build)].filter(Boolean).join(' · '))}
      </div>
    </div>`;
  },

  account() {
    const be = acct.backend;
    const beNote = be?.local ? `<div class="hint center">后端：本地开发（${esc(be.url.replace(/^https?:\/\//, ''))}）</div>` : '';
    const msg = auth.msg ? `<div class="msg ${auth.kind}">${msgHtml(auth.msg, auth.kind)}</div>` : '';
    if (!acct.configured) {
      return `${header('账户')}<div class="body"><div class="warn">账户服务尚未配置。开发者需要在 <code>src/shared/config.js</code> 中填写 Supabase 项目地址和 anon key，详见 <code>docs/backend.md</code>。</div></div>`;
    }

    // ---- 未登录：登录 / 注册（参考 Trancy：Google 登录 + 邮箱密码，金色主按钮） ----
    if (!acct.loggedIn) {
      const signup = auth.mode === 'signup';
      // 文案按页面区分：登录页“使用 Google 登录”、注册页“使用 Google 注册”（新账号首次授权即自动注册）
      const google = `<button class="oauth" type="button" data-act="oauth" data-provider="google" ${auth.busy ? 'disabled' : ''}>${IC.google}<span>${signup ? '使用 Google 注册' : '使用 Google 登录'}</span></button>`;
      const fields = `
          <label class="ifield"><span class="iicon">${IC.mail}</span>
            <input type="email" name="email" autocomplete="email" placeholder="邮箱" value="${esc(auth.email)}" required /></label>
          <label class="ifield"><span class="iicon">${IC.lock}</span>
            <input type="password" name="password" autocomplete="${signup ? 'new-password' : 'current-password'}" placeholder="${signup ? '密码（至少 6 位）' : '密码'}" minlength="6" required /></label>`;
      const submitText = auth.busy ? '请稍候…' : signup ? '免费注册' : '登录';
      const terms = TERMS.terms || TERMS.privacy
        ? `注册即表示你同意${TERMS.terms ? `<a href="${esc(TERMS.terms)}" target="_blank">《服务条款》</a>` : '《服务条款》'}，并已阅读${TERMS.privacy ? `<a href="${esc(TERMS.privacy)}" target="_blank">《隐私政策》</a>` : '《隐私政策》'}。`
        : '注册即表示你同意《服务条款》，并已阅读《隐私政策》。';
      return `<header class="hd"><button class="back" data-act="back" title="返回">${IC.back}</button><span class="hd-back">返回</span></header>
      <div class="body auth">
        <h2 class="auth-title">${signup ? '创建账号' : '欢迎回来'}</h2>
        <p class="auth-sub">${signup ? '免费注册，开通会员后可使用 DeepL 与 AI 翻译' : '登录后可开通会员、在多台设备同步生词本'}</p>
        ${google}
        <div class="or"><span>或使用邮箱</span></div>
        <form class="auth-form" id="authForm" novalidate>
          ${fields}
          ${msg}
          <button class="gold submit" type="submit" ${auth.busy ? 'disabled' : ''}>${submitText}</button>
        </form>
        ${
          signup
            ? `<p class="switch">已有账号？<button class="link gold-link" data-act="authMode" data-mode="signin">登录</button></p>
               <button class="outline" data-act="guest">暂不注册，继续免费使用</button>
               <p class="terms">${terms}</p>`
            : `<div class="auth-links"><button class="link" data-act="forgot">忘记密码？</button></div>
               <p class="switch">还没有账号？<button class="link gold-link" data-act="authMode" data-mode="signup">免费注册</button></p>`
        }
        ${beNote}
      </div>`;
    }

    // ---- 已登录 ----
    const a = acct.account || {};
    const member = isMember();
    const date = (iso) => (iso ? new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) : '');
    let status = '';
    if (member && a.status === 'past_due') status = '付款失败，请在“管理订阅”中更新支付方式';
    else if (member && a.cancelAtPeriodEnd) status = `已取消续费，${PLAN_NAME[plan()]} 有效期至 ${date(a.periodEnd)}`;
    else if (member && a.periodEnd) status = `${a.status === 'trialing' ? '试用中，' : ''}下次续费：${date(a.periodEnd)}`;
    else if (a.status === 'canceled') status = '订阅已结束';
    const initial = esc((acct.email || '?').trim()[0].toUpperCase());
    const u = a.usage || {};
    const fmt = (n) => (n >= 1e4 ? +(n / 1e4).toFixed(n >= 1e6 ? 0 : 1) + ' 万' : String(n || 0));
    const pct = Math.min(100, Math.round(((u.points || 0) / (u.limit || 15e6)) * 100));
    const cpct = Math.min(100, Math.round(((u.chars || 0) / (u.charLimit || (plan() === 'premium_plus' ? 2e5 : 1e5))) * 100));
    const usageHint =
      pct >= 100 ? '本月 AI 点数已用完：大模型暂停到下月 1 日，期间网页翻译自动改用 Google；DeepL、Microsoft 照常可用'
      : pct >= USAGE_WARN ? `已用 ${pct}%，用完后大模型会暂停到下月 1 日，期间自动改用 Google 翻译`
      : '每月 1 日重置；用完后可继续使用 Google、DeepL、Microsoft';
    const usageCard =
      (plan() === 'premium_plus'
        ? `<div class="card box usage ${pct >= USAGE_WARN ? 'warn' : ''}"><div class="line"><span class="t">本月 AI 点数</span><span class="s">${fmt(u.points)} / ${fmt(u.limit || 15e6)} 点</span></div>
           <div class="bar"><i style="width:${pct}%"></i></div><div class="hint">${usageHint}</div></div>`
        : '') +
      (member
        ? `<div class="card box usage chars ${cpct >= USAGE_WARN ? 'warn' : ''}"><div class="line"><span class="t">本月 DeepL / Microsoft</span><span class="s">${fmt(u.chars)} / ${fmt(u.charLimit || (plan() === 'premium_plus' ? 2e5 : 1e5))} 字符</span></div>
           <div class="bar"><i style="width:${cpct}%"></i></div><div class="hint">${cpct >= 100 ? '本月额度已用完：DeepL、Microsoft 暂停到下月 1 日，期间网页翻译自动改用 Google' : '每月 1 日重置；用完后自动改用 Google 翻译'}</div></div>`
        : '');

    return `${header('账户')}
    <div class="body">
      <div class="card box acct">
        <div class="avatar">${initial}</div>
        <div class="acct-info"><b>${esc(acct.email || '')}</b>
          <span class="plan ${member ? 'pro' : ''}">${member ? IC.crown + PLAN_NAME[plan()] + ' 会员' : '免费版'}</span></div>
        <button class="mini" data-act="acctRefresh" title="刷新会员状态">${IC.refresh}</button>
      </div>
      ${status ? `<div class="status-line">${esc(status)}</div>` : ''}
      ${msg}
      ${usageCard}
      ${
        member
          ? `${plan() === 'premium' ? `<button class="gold" data-act="premium">升级到 Premium+ 解锁全部 AI 引擎</button>` : ''}
             <button class="ghost wide" data-act="portal">${IC.card} 管理订阅</button>
             <div class="hint">在 Stripe 页面中切换方案、修改支付方式、取消订阅或下载发票。</div>`
          : `<div class="card box pro-card">
              <div class="pro-title">${IC.crown} 开通会员</div>
              <div class="s">Premium：无限生词本、云同步、DeepL / Microsoft 专业翻译<br/>Premium+：再加 GPT、Gemini、DeepSeek、Claude</div>
              <button class="gold" data-act="premium">查看会员方案</button>
            </div>
            ${a.hasBilling ? `<button class="link" data-act="portal">查看账单与发票 ${IC.chev}</button>` : ''}`
      }
      <button class="ghost wide danger" data-act="signOut">退出登录</button>
      ${beNote}
    </div>`;
  },

  words() {
    const mastered = words.filter((w) => w.m).length;
    return `${header(`生词本 · ${words.length}`)}
    <div class="body"><div class="card words-card">${
      words.length
        ? `<div class="wl-head"><span>已掌握 ${mastered} / ${words.length}</span>${expandBtn()}</div>
           <div class="hint">${isMember() ? '已同步到账号，换设备登录后自动恢复' : `免费版最多 ${FREE_WORD_LIMIT} 个，<button class="link gold-link" data-act="premium">开通 Premium</button> 不限数量并云同步`}</div>
           ${wordRows(words, expanded)}`
        : `<div class="empty">${IC.inbox}<div>暂无生词</div></div>`
    }</div></div>`;
  },

  pick(key) {
    const p = PICKERS[key];
    const cur = p.get(S);
    const opts = p.options()
      .map(
        ([v, label, tag = '', sub = '']) => `<button class="opt ${v === cur ? 'on' : ''}" data-set="${esc(v)}">
          <span class="lb">${esc(label)} ${tag}${sub ? `<small>${esc(sub)}</small>` : ''}</span>
          <span class="ck">${IC.check}</span></button>`
      )
      .join('');
    return `${header(p.title)}
    <div class="body">
      <div class="opts">${opts}</div>
      ${p.hint ? `<div class="hint">${p.hint}</div>` : ''}
      ${p.footer ? `<div>${p.footer}</div>` : ''}
    </div>`;
  },
};

function renderRail() {
  const rb = (attrs, icon, tip, cls = '') => `<button class="rb ${cls}" ${attrs} data-tip="${tip}">${icon}</button>`;
  const base = view.split(':')[0];
  const pick = view.startsWith('pick:') ? view.slice(5) : '';
  $('#rail').innerHTML = [
    rb('data-act="close"', IC.close, '关闭', 'close'),
    rb('data-go="home"', IC.home, '首页', base === 'home' ? 'cur' : ''),
    rb('data-go="settings"', IC.gear, '设置', base === 'settings' ? 'cur' : ''),
    page.supported ? rb('data-act="togglePage"', IC.translate, page.active ? '显示原文' : '翻译此页面', page.active ? 'lit' : '') : '',
    rb('data-pick="selection"', IC.cursor, '划词翻译', pick === 'selection' ? 'cur' : ''),
    rb('data-pick="youtube"', IC.video, '双语字幕', pick === 'youtube' ? 'cur' : ''),
    rb('data-go="words"', IC.book + (words.length ? `<span class="badge">${words.length > 99 ? '99+' : words.length}</span>` : ''), '生词本', base === 'words' ? 'cur' : ''),
    '<div class="sp"></div>',
    rb('data-act="options"', IC.sliders, '完整设置'),
  ].join('');
}

function render() {
  const [name, arg] = view.split(':');
  const scroll = $('.body')?.scrollTop || 0;
  $('#main').innerHTML = (VIEWS[name] || VIEWS.home)(arg);
  if (name === 'settings') $('.body').scrollTop = scroll;
  renderRail();
}

function go(next, push = true) {
  if (next === view) return;
  if (push && next.startsWith('pick:')) history.push(view);
  else if (next === 'account' && view === 'settings') history = ['settings'];
  else history = [];
  view = next;
  if (next === 'account') {
    auth.msg = '';
    // 进入账户页时后台刷新一次会员状态
    if (acct.loggedIn) loadAccount(true).then(() => view === 'account' && render());
  }
  render();
}

// 邮箱还没验证、或刚发出验证邮件时，提示后附“重新发送验证邮件”（链接过期、邮件没收到时的出路）
const needsResend = (text) => /邮箱尚未验证|验证邮件已发送/.test(text || '');
const msgHtml = (text, kind) =>
  esc(text) +
  (kind && needsResend(text) ? ` <button type="button" class="link gold-link resend" data-act="resendConfirm">重新发送验证邮件</button>` : '');

// 表单内的提示与按钮状态就地更新，不重绘表单，避免清空已输入的密码
function showMsg(text, kind) {
  auth.msg = text;
  auth.kind = kind;
  const form = $('#authForm');
  if (!form) return render();
  let m = form.querySelector('.msg');
  if (!m) {
    m = document.createElement('div');
    form.querySelector('.submit').before(m);
  }
  m.className = 'msg ' + kind;
  m.innerHTML = msgHtml(text, kind);
}

function setBusy(on) {
  auth.busy = on;
  const btn = $('#authForm .submit');
  if (!btn) return render();
  btn.disabled = on;
  btn.textContent = on ? '请稍候…' : auth.mode === 'signup' ? '免费注册' : '登录'; // 与 render 中的文字保持一致
}

async function busy(fn) {
  setBusy(true);
  showMsg('', '');
  try {
    await fn();
  } catch (e) {
    showMsg(e.message, 'err');
  } finally {
    setBusy(false);
  }
  if (auth.msg === '') $('#authForm .msg')?.remove();
}

async function submitAuth(form) {
  const f = new FormData(form);
  const email = String(f.get('email') || '').trim();
  const password = String(f.get('password') || '');
  auth.email = email;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showMsg('邮箱格式不正确', 'err');
  if (password.length < 6) return showMsg('密码至少需要 6 位', 'err');

  let done = false;
  let confirmSent = false;
  await busy(async () => {
    if (auth.mode === 'signup') {
      const r = await send('accountSignUp', { email, password });
      if (r.needConfirm) return (confirmSent = true);
    } else {
      await send('accountSignIn', { email, password });
    }
    await loadAccount();
    done = true;
  });
  if (confirmSent) {
    // 切到登录表单，保留邮箱，提示去验证
    auth.mode = 'signin';
    render();
    showMsg(`验证邮件已发送到 ${email}，点击邮件中的链接后回来登录`, 'ok');
  }
  if (done) {
    auth.msg = '';
    auth.mode = 'signin';
    render();
    toast('登录成功');
  }
}

// ---------------- 交互 ----------------
async function togglePage() {
  if (!page.supported) return;
  page.active = !page.active;
  render();
  await chrome.tabs.sendMessage(tab.id, { type: 'setPage', on: page.active }).catch(() => {});
}

async function quickTranslate(text) {
  quick = { text, out: '翻译中…', err: false };
  render();
  const isZh = /[一-鿿]/.test(text) && !/[぀-ヿ]/.test(text);
  const to = isZh && S.targetLang.startsWith('zh') ? 'en' : S.targetLang;
  const r = await chrome.runtime.sendMessage({ type: 'translate', texts: [text], to, from: 'auto' });
  quick = r?.ok ? { text, out: r.data[0], err: false } : { text, out: r?.error || '翻译失败', err: true };
  render();
  $('#quickInput')?.focus();
}

// 注册页填完邮箱就预先检查域名能不能收信（结果由后台缓存），点“免费注册”时不用再等
document.addEventListener('focusout', (e) => {
  if (e.target.name !== 'email' || auth.mode !== 'signup' || !e.target.closest('#authForm')) return;
  const email = e.target.value.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) chrome.runtime.sendMessage({ type: 'accountCheckEmail', email }).catch(() => {});
});

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button, input.sw');
  if (!b) return;
  const d = b.dataset;
  if (d.go) return go(d.go, false);
  if (d.pick) return go('pick:' + d.pick);
  if (d.set !== undefined) {
    const key = view.slice(5);
    const p = PICKERS[key];
    if (p.guard && !p.guard(d.set)) return;
    await save(p.set(d.set));
    p.after?.(d.set);
    render();
    return;
  }
  switch (d.act) {
    case 'close':
      return close();
    case 'openExt':
      return send('openExtensionsPage');
    case 'oauth':
      return busy(async () => {
        await send('accountOAuth', { provider: d.provider });
        await loadAccount();
        auth.msg = '';
        auth.mode = 'signin';
        render();
        toast('登录成功');
      });
    case 'guest':
      auth.msg = '';
      auth.mode = 'signin'; // 下次进入账户页时显示登录页
      view = 'home';
      history = [];
      return render();
    case 'authMode':
      auth.mode = d.mode;
      auth.msg = '';
      return render();
    case 'forgot': {
      const email = ($('#authForm [name=email]')?.value || '').trim();
      if (!email) return showMsg('请先填写邮箱，再点击“忘记密码”', 'err');
      auth.email = email;
      return busy(async () => {
        await send('accountReset', { email });
        showMsg(`重置密码邮件已发送到 ${email}`, 'ok');
      });
    }
    case 'signOut':
      auth = { ...auth, mode: 'signin', msg: '', kind: '', busy: false };
      await send('accountSignOut').catch(() => {});
      await loadAccount();
      render();
      return toast('已退出登录');
    case 'acctRefresh':
      await loadAccount(true);
      render();
      return toast('会员状态已刷新');
    case 'premium':
      return openPremium();
    case 'useGoogle':
      await save({ engine: 'google' });
      toast('已改用 Google 翻译');
      return render();
    case 'portal':
      return busy(() => send('billingPortal'));
    case 'back':
      view = history.pop() || 'home';
      return render();
    case 'togglePage':
      return togglePage();
    case 'always': {
      const set = new Set(S.alwaysSites);
      b.checked ? set.add(host) : set.delete(host);
      await save({ alwaysSites: [...set], neverSites: S.neverSites.filter((h) => h !== host) });
      if (b.checked && !page.active) await togglePage();
      return toast(b.checked ? '已加入总是翻译' : '已移出总是翻译');
    }
    case 'options':
      return openOptions(d.hash);
    case 'shortcuts':
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
      return MODE === 'popup' && window.close();
    case 'expand':
      expanded = !expanded;
      try {
        localStorage.setItem('gl-expand', expanded ? '1' : '0');
      } catch {}
      return render();
    case 'resendConfirm': {
      const email = ($('#authForm [name=email]')?.value || auth.email || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showMsg('请先填写注册时用的邮箱', 'err');
      try {
        await send('accountResend', { email });
        showMsg(`验证邮件已重新发送到 ${email}，请查收（也看看垃圾邮件），点击最新一封邮件中的链接`, 'ok');
      } catch (e) {
        showMsg(e.message, 'err');
      }
      return;
    }
    case 'quick': {
      const t = $('#quickInput')?.value.trim();
      if (t) quickTranslate(t);
      return;
    }
    case 'speak': {
      const w = findWord(d.k);
      if (!w) return;
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(w.w);
      u.lang = /[一-鿿]/.test(w.w) ? 'zh-CN' : 'en-US';
      return speechSynthesis.speak(u);
    }
    case 'master': {
      await saveWords(words.map((w) => (keyOf(w.w) === d.k ? { ...w, m: !w.m, u: Date.now() } : w)));
      const w = findWord(d.k);
      return toast(w?.m ? '已标记为掌握' : '已取消掌握');
    }
    case 'unsave': {
      const w = findWord(d.k);
      if (w) await send('toggleWord', { word: w.w });
      return toast('已从生词本移除');
    }
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id !== 'authForm') return;
  e.preventDefault();
  if (!auth.busy) submitAuth(e.target);
});
document.addEventListener('input', (e) => {
  if (e.target.name === 'email' && e.target.closest('#authForm')) auth.email = e.target.value;
});

document.addEventListener('keydown', (e) => {
  if (e.target.id === 'quickInput' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    const text = e.target.value.trim();
    if (text) quickTranslate(text);
  }
  if (e.key === 'Escape' && MODE === 'drawer') close();
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'quickInput') quick.text = e.target.value;
});

// 设置、生词在其他地方被修改时（如网页上的悬浮球、划词面板），同步刷新
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) S = await getSettings();
  if (changes.words) {
    words = changes.words.newValue || [];
    await refreshPageWords();
  }
  if (changes.auth || changes.account) {
    const before = acct.account?.plan;
    await loadAccount();
    if (acct.account?.plan !== before) auth.msg = ''; // 会员状态变化后，清掉“已打开支付页面”等旧提示
  }
  // 正在输入时不重绘，避免清空输入框
  const a = document.activeElement;
  const typing = a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type !== 'checkbox'));
  if (!typing) render();
});
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'pageStateChanged' && sender.tab?.id === tab?.id) {
    page.active = !!msg.active;
    render();
  }
});

// ---------------- 启动 ----------------
tab = await resolveTab();
try {
  host = new URL(tab?.url || '').hostname;
} catch {}
await refreshPage();
await refreshPageWords();
await loadAccount();
build = await send('buildInfo').catch(() => null);
if (acct.loggedIn) loadAccount(true).then(render); // 后台刷新会员状态
if (view.startsWith('pick:')) history = ['settings'];
render();
