import { getSettings, saveSettings, ENGINES, DEFAULT_SETTINGS, PLAN_NAME, canUse } from '../src/shared/settings.js';
import { LANGUAGES, TARGET_LANGUAGES } from '../src/shared/languages.js';
import { buildLabel, buildShort } from '../src/shared/build.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
let S = await getSettings();

$('#ver').textContent = 'v' + chrome.runtime.getManifest().version;

// 当前加载的版本；磁盘代码已更新但未刷新插件时提示
async function showBuild() {
  const r = await chrome.runtime.sendMessage({ type: 'buildInfo' }).catch(() => null);
  if (!r?.ok) return;
  const info = r.data;
  $('#ver').textContent = buildLabel(info);
  $('#buildVal').textContent = buildLabel(info);
  $('#buildVal').classList.toggle('stale', info.stale);
  if (info.stale) $('#buildVal').textContent += `（磁盘上已是 ${buildShort(info, 'disk')}，需要刷新）`;
  $('#staleBar').hidden = !info.stale;
}
showBuild();

// 开发版：在云端与本机 Supabase 之间切换（正式版不显示）
async function showDevBackend() {
  const r = await chrome.runtime.sendMessage({ type: 'devBackend' }).catch(() => null);
  const d = r?.data;
  if (!r?.ok || !d.dev) return;
  $('#devBackendRow').hidden = false;
  $('#devBackendSel').value = d.local ? 'local' : 'cloud';
  $('#devBackendSel').querySelector('[value=cloud]').disabled = !d.cloudConfigured;
  $('#devBackendHint').textContent = (d.url || '未配置') + (d.local ? '，邮件在 Mailpit（127.0.0.1:54324）查看' : '');
}
// ---------- 账户与会员 ----------
const escA = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const PLAN_LABEL = { free: '免费版', premium: 'Premium 会员', premium_plus: 'Premium+ 会员' };
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) : '');
const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + ' 百万' : n >= 1e4 ? (n / 1e4).toFixed(1) + ' 万' : String(n || 0));
async function showAccount() {
  const r = await chrome.runtime.sendMessage({ type: 'accountState' }).catch(() => null);
  const st = r?.data || {};
  const box = $('#acctBox');
  if (!st.configured) {
    box.innerHTML = '<div class="field"><label>账户服务尚未配置</label></div>';
    return;
  }
  if (!st.loggedIn) {
    box.innerHTML = `<div class="field"><label>未登录 <span class="hint">账号用于开通会员和同步生词本</span></label>
      <div class="btns"><button class="ghost" data-acct="plans">查看会员方案</button><button class="primary" data-acct="login">登录 / 注册</button></div></div>`;
    return;
  }
  const a = st.account || { plan: 'free' };
  const member = a.plan !== 'free';
  const status = !member ? '' : a.cancelAtPeriodEnd ? `已取消续费，有效期至 ${fmtDate(a.periodEnd)}` : a.periodEnd ? `下次续费：${fmtDate(a.periodEnd)}` : '';
  const u = a.usage || {};
  const pct = Math.min(100, Math.round(((u.tokens || 0) / (u.limit || 20e6)) * 100));
  box.innerHTML = `<div class="field"><label>${escA(st.email || '')} <span class="hint">${escA(status)}</span></label>
      <span class="plan-tag ${member ? 'on' : ''}" id="acctPlan">${PLAN_LABEL[a.plan]}</span></div>
    ${a.plan === 'premium_plus' ? `<div class="field"><label>本月 AI 用量 <span class="hint">${fmtTok(u.tokens)} / ${fmtTok(u.limit || 20e6)} Token · 每月 1 日重置</span></label>
      <span class="usage-pct ${pct >= 80 ? 'warn' : ''}">${pct}%</span></div>` : ''}
    <div class="field"><label>会员</label><div class="btns">
      ${a.plan === 'free' ? '<button class="primary" data-acct="plans">开通会员</button>' : ''}
      ${a.plan === 'premium' ? '<button class="primary" data-acct="plans">升级到 Premium+</button>' : ''}
      ${a.hasBilling ? '<button class="ghost" data-acct="portal">管理订阅</button>' : ''}
      <button class="ghost" data-acct="logout">退出登录</button></div></div>`;
}
showAccount();
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== 'local' || (!c.auth && !c.account)) return;
  if (c.auth?.newValue && !c.auth?.oldValue) closeLogin(); // 弹窗中登录成功
  showAccount();
});
function closeLogin() {
  $('#loginModal').hidden = true;
  $('#loginFrame').src = 'about:blank';
}
$('#closeLogin').onclick = closeLogin;
$('#loginModal').addEventListener('click', (e) => e.target.id === 'loginModal' && closeLogin());
$('#acctBox').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-acct]')?.dataset.acct;
  if (act === 'login') {
    $('#loginFrame').src = chrome.runtime.getURL('panel/panel.html?view=account');
    $('#loginModal').hidden = false;
  }
  if (act === 'plans') chrome.runtime.sendMessage({ type: 'openPremium' });
  if (act === 'portal') {
    const r = await chrome.runtime.sendMessage({ type: 'billingPortal' });
    if (!r?.ok) toast(r?.error || '打开失败');
  }
  if (act === 'logout') {
    await chrome.runtime.sendMessage({ type: 'accountSignOut' });
    toast('已退出登录');
  }
});

showDevBackend();
$('#devBackendSel').onchange = async (e) => {
  const r = await chrome.runtime.sendMessage({ type: 'devBackend', target: e.target.value });
  toast(r?.ok ? '已切换后端，请重新登录' : r?.error || '切换失败');
  showDevBackend();
};
$('#openExt').onclick = () => chrome.runtime.sendMessage({ type: 'openExtensionsPage' });

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 1600);
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- 下拉框选项 ----------
const opts = (list) => list.map((l) => `<option value="${l.code}">${l.name}</option>`).join('');
$('#targetLang').innerHTML = opts(TARGET_LANGUAGES);
$('#inputLang').innerHTML = opts(TARGET_LANGUAGES);
$('#sourceLang').innerHTML = opts(LANGUAGES);
$('#engineSel').innerHTML = ENGINES.map((e) => `<option value="${e.id}">${e.name}${e.tier === 'free' ? '' : '（' + PLAN_NAME[e.tier] + '）'}</option>`).join('');

// ---------- data-path 双向绑定 ----------
const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function patchOf(path, value) {
  const keys = path.split('.');
  const root = {};
  keys.reduce((o, k, i) => (o[k] = i === keys.length - 1 ? value : {}), root);
  return root;
}

function readInput(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.dataset.type === 'number') return Number(el.value);
  if (el.dataset.type === 'lines')
    return el.value
      .split('\n')
      .map((s) => s.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      .filter(Boolean);
  return el.value;
}

function writeInput(el, v) {
  if (el.type === 'checkbox') el.checked = !!v;
  else if (el.dataset.type === 'lines') el.value = (v || []).join('\n');
  else el.value = v ?? '';
}

function bindAll() {
  $$('[data-path]').forEach((el) => {
    writeInput(el, getPath(S, el.dataset.path));
    if (el._bound) return;
    el._bound = true;
    const evt = el.tagName === 'TEXTAREA' || el.type === 'text' || el.type === 'number' ? 'change' : 'input';
    el.addEventListener(evt, async () => {
      S = await saveSettings(patchOf(el.dataset.path, readInput(el)));
      toast('已保存');
      if (el.dataset.path === 'engine') renderEngines();
      if (el.dataset.path === 'transColor') applyPreview();
    });
  });
}

// ---------- 翻译服务卡片 ----------
// 除 Google 外，全部由微光翻译服务器提供，不再需要（也不能）填写 API Key
const ENGINE_UI = {
  google: { logo: 'G', color: '#4285f4', desc: '免费，无需登录，速度快，覆盖语言最多。' },
  deepl: { logo: 'D', color: '#0f2b46', desc: '欧洲语言翻译质量出色，适合正式文档。' },
  microsoft: { logo: 'M', color: '#00a4ef', desc: '与 Edge 浏览器内置翻译同源，速度快、稳定。' },
  openai: { logo: 'AI', color: '#10a37f', desc: 'GPT 大模型，理解上下文，译文自然。' },
  gemini: { logo: '✦', color: '#1a73e8', desc: 'Google Gemini 大模型，速度快。' },
  deepseek: { logo: 'DS', color: '#4d6bfe', desc: '中文能力强，适合中英互译。' },
  claude: { logo: 'C', color: '#d97757', desc: '译文流畅，擅长长文与专业内容。' },
};

let plan = 'free';
async function loadPlan() {
  const { account } = await chrome.storage.local.get('account');
  plan = account?.plan || 'free';
}

function renderEngines() {
  const box = $('#engineCards');
  box.innerHTML = ENGINES.map((e) => {
    const ui = ENGINE_UI[e.id];
    const isDefault = S.engine === e.id;
    const ok = canUse(plan, e.id);
    const tag = e.tier === 'free' ? '<span class="e-tag free">免费</span>' : `<span class="e-tag ${e.tier === 'premium_plus' ? 'llm' : ''}">${PLAN_NAME[e.tier]}</span>`;
    const action = ok
      ? `<button class="ghost use ${isDefault ? 'on' : ''}" data-act="use">${isDefault ? '默认' : '设为默认'}</button>`
      : '<button class="ghost use" data-act="premium">升级解锁</button>';
    return `
      <div class="card engine ${isDefault ? 'default' : ''} ${ok ? '' : 'locked'}" data-id="${e.id}">
        <div class="e-head">
          <div class="e-logo" style="background:${ui.color}">${ui.logo}</div>
          <div><span class="e-name">${e.name}</span>${tag}</div>
          ${action}
        </div>
        <p class="e-desc">${ui.desc}${e.tier === 'free' ? '' : ' 由微光翻译服务器提供，无需 API Key。'}</p>
        <div class="e-foot">
          ${ok ? '<button class="ghost test" data-act="test">测试连接</button>' : `<span class="e-result">需要 ${PLAN_NAME[e.tier]} 会员</span>`}
          ${ok ? '<span class="e-result"></span>' : ''}
        </div>
      </div>`;
  }).join('');
  $('#engineSel').value = S.engine;
}

$('#engineCards').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = btn.closest('.engine').dataset.id;
  if (btn.dataset.act === 'premium') return chrome.runtime.sendMessage({ type: 'openPremium' });
  if (btn.dataset.act === 'use') {
    S = await saveSettings({ engine: id });
    renderEngines();
    toast('已设为默认翻译服务');
  }
  if (btn.dataset.act === 'test') {
    const out = btn.parentElement.querySelector('.e-result');
    out.className = 'e-result';
    out.textContent = '测试中…';
    btn.disabled = true;
    const r = await chrome.runtime.sendMessage({ type: 'testEngine', engine: id });
    btn.disabled = false;
    if (r?.ok) {
      out.className = 'e-result ok';
      out.textContent = `✓ ${r.data.ms}ms · ${r.data.text}`;
    } else {
      out.className = 'e-result err';
      out.textContent = '✗ ' + (r?.error || '失败');
    }
  }
});

// 默认引擎下拉框：只允许选择已解锁的引擎
$('#engineSel').addEventListener('change', async (e) => {
  if (canUse(plan, e.target.value)) return;
  toast(`该引擎需要 ${PLAN_NAME[ENGINES.find((x) => x.id === e.target.value).tier]} 会员`);
  e.target.value = S.engine;
  e.stopImmediatePropagation();
}, true);

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local' && changes.account) {
    await loadPlan();
    renderEngines();
  }
});

// ---------- 译文样式 ----------
const STYLES = [
  { v: 'none', name: '默认', d: '与原文一致' },
  { v: 'underline', name: '下划线', d: '实线强调' },
  { v: 'dashed', name: '虚线', d: '虚线下划线' },
  { v: 'highlight', name: '高亮', d: '背景色块' },
  { v: 'border', name: '引用条', d: '左侧竖线' },
  { v: 'weak', name: '弱化', d: '降低透明度' },
  { v: 'color', name: '彩色', d: '强调色文字' },
  { v: 'blur', name: '学习模式', d: '悬停显示译文' },
];

function renderStyles() {
  $('#styleGrid').innerHTML = STYLES.map(
    (s) => `<button class="style-opt ${S.transStyle === s.v ? 'on' : ''}" data-v="${s.v}"><span class="demo">${s.name}</span><small>${s.d}</small></button>`
  ).join('');
  applyPreview();
}

function applyPreview() {
  const r = document.documentElement;
  r.setAttribute('data-gl-style', S.transStyle);
  r.style.setProperty('--gl-color', S.transColor);
}

$('#styleGrid').addEventListener('click', async (e) => {
  const b = e.target.closest('.style-opt');
  if (!b) return;
  S = await saveSettings({ transStyle: b.dataset.v });
  renderStyles();
  toast('已保存');
});

// ---------- 其他按钮 ----------
$('#clearCache').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'clearCache' });
  toast('缓存已清除');
};
$('#shortcuts').onclick = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
$('#exportBtn').onclick = () => {
  const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'glimmer-settings.json';
  a.click();
  URL.revokeObjectURL(a.href);
};
$('#importBtn').onclick = () => $('#importFile').click();
$('#importFile').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    await chrome.storage.local.set({ settings: data });
    S = await getSettings();
    renderAll();
    toast('导入成功');
  } catch {
    toast('文件格式错误');
  }
};
$('#resetAll').onclick = async () => {
  if (!confirm('确定恢复所有默认设置吗？API Key 也会被清空。')) return;
  await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  S = await getSettings();
  renderAll();
  toast('已恢复默认');
};

// ---------- 侧边栏高亮 ----------
const io = new IntersectionObserver(
  (entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting)
        $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.sec === en.target.id));
    });
  },
  { rootMargin: '-30% 0px -60% 0px' }
);
$$('.sec').forEach((s) => io.observe(s));

async function renderAll() {
  await loadPlan();
  bindAll();
  renderEngines();
  renderStyles();
}
renderAll();
if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
