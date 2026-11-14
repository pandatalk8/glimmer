import { getSettings, saveSettings, ENGINES } from '../src/shared/settings.js';
import { LANGUAGES, TARGET_LANGUAGES } from '../src/shared/languages.js';

const $ = (id) => document.getElementById(id);
let S = await getSettings();
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
let host = '';
try {
  host = new URL(tab.url).hostname;
} catch {}

$('ver').textContent = 'v' + chrome.runtime.getManifest().version;
$('hostName').textContent = host || '此网站';

// ---------- 语言 & 引擎 ----------
const opt = (v, t, sel) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${t}</option>`;
$('sourceLang').innerHTML = LANGUAGES.map((l) => opt(l.code, l.name, S.sourceLang)).join('');
$('targetLang').innerHTML = TARGET_LANGUAGES.map((l) => opt(l.code, l.name, S.targetLang)).join('');

function renderEngines() {
  $('engine').innerHTML = ENGINES.map((e) => {
    const cfg = S.engines[e.id] || {};
    const missing = e.needKey && !cfg.apiKey;
    return opt(e.id, e.name + (e.free ? ' · 免费' : missing ? ' · 未配置' : ''), S.engine);
  }).join('');
}
renderEngines();

$('sourceLang').onchange = (e) => save({ sourceLang: e.target.value });
$('targetLang').onchange = (e) => save({ targetLang: e.target.value });
$('swap').onclick = () => {
  if (S.sourceLang === 'auto') return;
  const [s, t] = [S.targetLang, S.sourceLang];
  $('sourceLang').value = s;
  $('targetLang').value = t;
  save({ sourceLang: s, targetLang: t });
};
$('engine').onchange = (e) => {
  const eng = ENGINES.find((x) => x.id === e.target.value);
  save({ engine: eng.id });
  if (eng.needKey && !S.engines[eng.id]?.apiKey) {
    note(`${eng.name} 需要 API Key，`, true);
  } else note('');
};

async function save(patch) {
  S = await saveSettings(patch);
}

function note(msg, withLink) {
  const n = $('note');
  n.hidden = !msg;
  n.innerHTML = msg + (withLink ? '<a href="#" id="goKey">去设置</a>' : '');
  if (withLink) $('goKey').onclick = () => openOptions('engines');
}

// ---------- 页面翻译开关 ----------
let active = false;
function renderToggle() {
  $('toggle').classList.toggle('on', active);
  $('toggleText').textContent = active ? '显示原文' : '翻译此页面';
}

async function queryState() {
  try {
    const st = await chrome.tabs.sendMessage(tab.id, { type: 'getState' }, { frameId: 0 });
    active = !!st?.active;
    renderToggle();
    return true;
  } catch {
    $('toggle').disabled = true;
    $('toggle').style.opacity = 0.5;
    note('当前页面不支持翻译（浏览器内置页面或需刷新页面）');
    return false;
  }
}
queryState();

$('toggle').onclick = async () => {
  active = !active;
  renderToggle();
  await chrome.tabs.sendMessage(tab.id, { type: 'setPage', on: active }).catch(() => {});
};

// ---------- 显示模式 ----------
function renderMode() {
  document.querySelectorAll('#displayMode button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.displayMode));
}
renderMode();
$('displayMode').onclick = async (e) => {
  const v = e.target.closest('button')?.dataset.v;
  if (!v) return;
  await save({ displayMode: v });
  renderMode();
};

// ---------- 开关 ----------
$('alwaysSite').checked = !!host && S.alwaysSites.includes(host);
$('floatBall').checked = S.floatBall;
$('selection').checked = S.selection.enabled;
$('alwaysSite').onchange = async (e) => {
  if (!host) return;
  const set = new Set(S.alwaysSites);
  e.target.checked ? set.add(host) : set.delete(host);
  const never = S.neverSites.filter((h) => h !== host);
  await save({ alwaysSites: [...set], neverSites: never });
  if (e.target.checked && !active) $('toggle').click();
};
$('floatBall').onchange = (e) => save({ floatBall: e.target.checked });
$('selection').onchange = (e) => save({ selection: { enabled: e.target.checked } });

// ---------- 快速翻译 ----------
$('quickInput').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  const text = e.target.value.trim();
  if (!text) return;
  const out = $('quickOut');
  out.hidden = false;
  out.className = 'quick-out';
  out.textContent = '翻译中…';
  // 中英自动互译：输入已是目标语言时翻译成英文
  const isZh = /[一-鿿]/.test(text) && !/[぀-ヿ]/.test(text);
  let to = S.targetLang;
  if (isZh && S.targetLang.startsWith('zh')) to = 'en';
  const r = await chrome.runtime.sendMessage({ type: 'translate', texts: [text], to, from: 'auto' });
  if (r?.ok) out.textContent = r.data[0];
  else {
    out.className = 'quick-out err';
    out.textContent = r?.error || '翻译失败';
  }
});

// ---------- 链接 ----------
function openOptions(hash = '') {
  chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') + (hash ? '#' + hash : '') });
  window.close();
}
$('openOptions').onclick = () => openOptions();
$('optionsLink').onclick = (e) => (e.preventDefault(), openOptions());
$('shortcuts').onclick = (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
};
