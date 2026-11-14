import { getSettings, saveSettings, ENGINES, DEFAULT_SETTINGS, DEFAULT_PROMPT } from '../src/shared/settings.js';
import { LANGUAGES, TARGET_LANGUAGES } from '../src/shared/languages.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
let S = await getSettings();

$('#ver').textContent = 'v' + chrome.runtime.getManifest().version;

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
$('#engineSel').innerHTML = ENGINES.map((e) => `<option value="${e.id}">${e.name}</option>`).join('');

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
const ENGINE_UI = {
  google: { logo: 'G', color: '#4285f4', desc: '免费，无需配置，速度快，覆盖语言最多。', fields: [] },
  microsoft: {
    logo: 'M', color: '#00a4ef', desc: 'Azure 翻译服务，免费层每月 200 万字符。在 Azure 门户创建 Translator 资源获取 Key。',
    fields: [
      { k: 'apiKey', label: 'API Key', secret: true, ph: 'Azure Translator Key' },
      { k: 'region', label: '区域（全局资源可留空）', ph: 'eastasia', list: ['global', 'eastasia', 'southeastasia', 'eastus', 'westeurope'] },
    ],
  },
  deepl: {
    logo: 'D', color: '#0f2b46', desc: '欧洲语言翻译质量出色。免费 Key 以 :fx 结尾，会自动使用 Free 接口。',
    fields: [
      { k: 'apiKey', label: 'API Key', secret: true, ph: 'xxxxxxxx-xxxx-xxxx:fx' },
      { k: 'apiUrl', label: '自定义 API 地址（可选）', ph: '留空则自动选择 Free / Pro' },
    ],
  },
  openai: {
    logo: 'AI', color: '#10a37f', desc: 'OpenAI 官方接口，也可填任何 OpenAI 兼容的代理地址。',
    fields: [
      { k: 'apiKey', label: 'API Key', secret: true, ph: 'sk-...' },
      { k: 'baseUrl', label: 'API 地址', ph: 'https://api.openai.com/v1' },
      { k: 'model', label: '模型', list: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'gpt-4o', 'gpt-5-mini', 'gpt-5'] },
    ],
  },
  gemini: {
    logo: '✦', color: '#1a73e8', desc: 'Google Gemini，在 Google AI Studio 免费申请 API Key。',
    fields: [
      { k: 'apiKey', label: 'API Key', secret: true, ph: 'AIza...' },
      { k: 'model', label: '模型', list: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'] },
    ],
  },
  deepseek: {
    logo: 'DS', color: '#4d6bfe', desc: 'DeepSeek 中文能力强，价格低。',
    fields: [
      { k: 'apiKey', label: 'API Key', secret: true, ph: 'sk-...' },
      { k: 'baseUrl', label: 'API 地址', ph: 'https://api.deepseek.com' },
      { k: 'model', label: '模型', list: ['deepseek-chat', 'deepseek-reasoner'] },
    ],
  },
  claude: {
    logo: 'C', color: '#d97757', desc: 'Anthropic Claude，译文自然流畅，擅长长文与专业内容。',
    fields: [
      { k: 'apiKey', label: 'API Key', secret: true, ph: 'sk-ant-...' },
      { k: 'model', label: '模型', list: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] },
    ],
  },
  custom: {
    logo: '⚙', color: '#6b6b80', desc: '任何 OpenAI 兼容接口：Ollama、LM Studio、OpenRouter、通义千问、Kimi、智谱等。',
    fields: [
      { k: 'baseUrl', label: 'API 地址', ph: 'http://localhost:11434/v1' },
      { k: 'apiKey', label: 'API Key（可选）', secret: true, ph: '本地模型可留空' },
      { k: 'model', label: '模型', ph: 'qwen2.5:7b' },
    ],
  },
};

function renderEngines() {
  const box = $('#engineCards');
  box.innerHTML = ENGINES.map((e) => {
    const ui = ENGINE_UI[e.id];
    const cfg = S.engines[e.id] || {};
    const isDefault = S.engine === e.id;
    const tag = e.free ? '<span class="e-tag free">免费</span>' : e.type === 'llm' ? '<span class="e-tag llm">大模型</span>' : '<span class="e-tag">API</span>';
    const fields = ui.fields
      .map((f) => {
        const listId = f.list ? `dl-${e.id}-${f.k}` : '';
        const input = `<input type="${f.secret ? 'password' : 'text'}" data-engine="${e.id}" data-k="${f.k}" value="${esc(cfg[f.k])}" placeholder="${esc(f.ph || '')}" ${listId ? `list="${listId}"` : ''} spellcheck="false" autocomplete="off" />`;
        const dl = f.list ? `<datalist id="${listId}">${f.list.map((m) => `<option value="${m}">`).join('')}</datalist>` : '';
        return `<label class="e-field"><span>${f.label}</span>${f.secret ? `<div class="pw">${input}<button class="eye" type="button" title="显示/隐藏">👁</button></div>` : input}${dl}</label>`;
      })
      .join('');
    return `
      <div class="card engine ${isDefault ? 'default' : ''}" data-id="${e.id}">
        <div class="e-head">
          <div class="e-logo" style="background:${ui.color}">${ui.logo}</div>
          <div><span class="e-name">${e.name}</span>${tag}</div>
          <button class="ghost use ${isDefault ? 'on' : ''}" data-act="use">${isDefault ? '默认' : '设为默认'}</button>
        </div>
        <p class="e-desc">${ui.desc}</p>
        ${fields}
        <div class="e-foot">
          <button class="ghost test" data-act="test">测试连接</button>
          <span class="e-result"></span>
        </div>
      </div>`;
  }).join('');
  $('#engineSel').value = S.engine;
}

$('#engineCards').addEventListener('change', async (e) => {
  const el = e.target;
  if (!el.dataset.engine) return;
  S = await saveSettings({ engines: { [el.dataset.engine]: { [el.dataset.k]: el.value.trim() } } });
  toast('已保存');
});

$('#engineCards').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const card = btn.closest('.engine');
  const id = card.dataset.id;
  if (btn.classList.contains('eye')) {
    const inp = btn.previousElementSibling;
    inp.type = inp.type === 'password' ? 'text' : 'password';
    return;
  }
  if (btn.dataset.act === 'use') {
    S = await saveSettings({ engine: id });
    renderEngines();
    toast('已设为默认翻译服务');
  }
  if (btn.dataset.act === 'test') {
    // 先保存卡片中所有输入
    const patch = {};
    card.querySelectorAll('input[data-k]').forEach((i) => (patch[i.dataset.k] = i.value.trim()));
    S = await saveSettings({ engines: { [id]: patch } });
    const out = card.querySelector('.e-result');
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
$('#resetPrompt').onclick = async () => {
  S = await saveSettings({ llm: { prompt: DEFAULT_PROMPT } });
  bindAll();
  toast('已恢复默认 Prompt');
};
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

function renderAll() {
  bindAll();
  renderEngines();
  renderStyles();
}
renderAll();
if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
